import base64
import contextlib
import hashlib
import http.server
import importlib.util
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('audit', HERE / 'audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

class AuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.tokenizer = audit.load_tokenizer()
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        (self.repo / 'sample.ts').write_bytes(b'export const value = 1;\n')
        (self.repo / 'second.ts').write_bytes(b'export const value = 7;\n')
        (self.repo / 'utils-sleep.ts').write_bytes((HERE.parent / 'utils-sleep.ts').read_bytes())
        (self.repo / 'README.md').write_bytes(b'Synthetic notes.\n')
        (self.repo / 'link.ts').symlink_to('sample.ts')
        self.git('add', '.')
        self.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture')
        self.sha = self.git('rev-parse','HEAD').strip()
        self.blob = self.git('rev-parse','HEAD:sample.ts').strip()
        self.inputs = {'nonce':'a'*64, 'path':'sample.ts','base_blob':self.blob,
                       'candidate_b64':base64.b64encode(b'export const value = 2;\n').decode(),
                       'workflow_sha':self.sha,'run_id':'123','run_attempt':'1'}
    def tearDown(self): self.tmp.cleanup()
    def git(self, *args):
        return subprocess.check_output(['git','-C',str(self.repo),*args], stderr=subprocess.PIPE).decode()
    def prepare(self, **changes): return audit.prepare(self.inputs | changes, str(self.repo))
    def transport(self, votes=None, digest=audit.MODEL_DIGEST):
        calls = []
        votes = iter(votes if votes is not None else ['{"safe":true}'] * 3)
        def send(path, payload=None):
            calls.append((path,payload))
            if path == '/api/version': return {'version':audit.RUNTIME_VERSION}
            if path == '/api/tags': return {'models':[{'name':audit.MODEL,'digest':digest}]}
            return {'model':audit.MODEL,'done':True,'done_reason':'stop','prompt_eval_count':len(self.tokenizer.encode(payload['prompt'],add_special_tokens=False).ids),
                    'response':next(votes)}
        return send,calls
    def test_exact_baseline_candidate_diff_and_bindings(self):
        p=self.prepare(); self.assertEqual(p['baseline'],'export const value = 1;\n')
        self.assertEqual(p['candidate'],'export const value = 2;\n')
        self.assertIn('-export const value = 1;',p['diff']); self.assertIn('+export const value = 2;',p['diff'])
        self.assertEqual(p['candidate_sha256'],hashlib.sha256(p['candidate'].encode()).hexdigest())
        send,calls=self.transport(); result=audit.verdict(p,audit.review(p,send))
        self.assertTrue(result['safe']); self.assertEqual(result['version'],1)
        self.assertEqual(result['workflow_sha'],self.sha); self.assertEqual(result['run_id'],'123')
        self.assertEqual(result['providers'],list(audit.PROVIDERS))
        for _, body in calls[2:]:
            for key in ('baseline','candidate','diff','base_blob','candidate_sha256'):
                self.assertIn(key,body['prompt'])
            self.assertIn('UNTRUSTED DATA',body['prompt']); self.assertTrue(body['raw'])
            self.assertFalse(body['truncate']); self.assertFalse(body['shift'])
    def test_diff_preserves_missing_newline_and_cr_byte_boundaries(self):
        cases = [
            (b'let x = 1;', b'let x = 2;',
             '-let x = 1;\n\\ No newline at end of file\n+let x = 2;\n\\ No newline at end of file\n'),
            (b'one\rtwo\n', b'one\rthree\n',
             '@@ -1 +1 @@\n-one\rtwo\n+one\rthree\n'),
            (b'first\nlast', b'first\nlast\n',
             '-last\n\\ No newline at end of file\n+last\n'),
        ]
        for baseline, candidate, expected in cases:
            with self.subTest(baseline=baseline, candidate=candidate):
                (self.repo / 'sample.ts').write_bytes(baseline)
                self.git('add', 'sample.ts')
                self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture change')
                sha = self.git('rev-parse', 'HEAD').strip()
                blob = self.git('rev-parse', 'HEAD:sample.ts').strip()
                p = self.prepare(workflow_sha=sha, base_blob=blob,
                                 candidate_b64=base64.b64encode(candidate).decode())
                self.assertEqual(p['baseline'].encode(), baseline)
                self.assertEqual(p['candidate'].encode(), candidate)
                self.assertEqual(p['candidate_sha256'], hashlib.sha256(candidate).hexdigest())
                self.assertIn(expected, p['diff'])
                send, calls = self.transport()
                self.assertTrue(audit.verdict(p, audit.review(p, send))['safe'])
                for _, payload in calls[2:]:
                    data = payload['prompt'].split('Untrusted JSON data follows:\n', 1)[1].split('<|im_end|>', 1)[0]
                    record = json.loads(data)
                    self.assertEqual(record['baseline'].encode(), baseline)
                    self.assertEqual(record['candidate'].encode(), candidate)
                    self.assertEqual(record['candidate_sha256'], hashlib.sha256(candidate).hexdigest())
                    self.assertEqual(record['diff'], p['diff'])

    def test_each_invalid_or_false_vote_fails_closed(self):
        p = self.prepare()
        for index in range(3):
            for bad in ('{"safe":false}', '{"safe":true,"safe":false}', '{}', '{"safe":1}'):
                responses = ['{"safe":true}'] * 3
                responses[index] = bad
                send, _ = self.transport(responses)
                with self.subTest(index=index, response=bad):
                    self.assertFalse(audit.verdict(p, audit.review(p, send))['safe'])

    def test_bad_input_matrix(self):
        cases=[{'nonce':'A'*64},{'nonce':'a'*63},{'path':'../sample.ts'},
               {'path':'link.ts'},{'path':'second.ts'},{'path':'auditor/audit.py'},
               {'path':'sample.ts\n'},{'base_blob':'0'*40},{'workflow_sha':'0'*40},
               {'run_attempt':'2'},{'run_id':'0'},{'candidate_b64':'!'},
               {'candidate_b64':base64.b64encode(b'password = x').decode()},
               {'candidate_b64':base64.b64encode(b'\xff').decode()},
               {'candidate_b64':base64.b64encode(b'x'*4097).decode()},
               {'candidate_b64':base64.b64encode(b'export const value = 1;\n').decode()}]
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(Exception): self.prepare(**case)
    def test_same_blob_wrong_path_fails(self):
        with self.assertRaises(Exception): self.prepare(path='second.ts')
    def test_model_failure_modes_fail_closed(self):
        p=self.prepare()
        responses=['{"safe":false}', '{}','{"safe":1}',
                   '{"safe":true,"safe":true}',
                   'prefix {"safe":true}', '{"safe":true,"reason":"unsafe"}',
                   '{"safe":true,"extra":0}', '{"safe":true} trailing']
        for response in responses:
            with self.subTest(response=response):
                send,_=self.transport([response]*3)
                self.assertFalse(audit.verdict(p,audit.review(p,send))['safe'])
        for digest in ('0'*64, ''):
            send,_=self.transport(digest=digest)
            self.assertFalse(audit.verdict(p,audit.review(p,send))['safe'])
        def unavailable(*args): raise OSError('offline')
        self.assertFalse(audit.verdict(p,audit.review(p,unavailable))['safe'])
    def test_missing_or_duplicate_votes_never_approve(self):
        p=self.prepare(); v={'provider':audit.PROVIDERS[0],'is_safe':True}
        for votes in ([],[v],[v,v,v], [{'provider':n,'is_safe':1} for n in audit.PROVIDERS]):
            self.assertFalse(audit.verdict(p,votes)['safe'])
    def test_conflicting_or_unknown_envelope_fails_closed(self):
        p=self.prepare()
        for field, value in (('unsafe', True), ('is_safe', False), ('error', 'bad'),
                             ('tool_calls', []), ('refusal', 'no'), ('unknown', {})):
            send,_=self.transport()
            def amended(path, payload=None):
                r=send(path,payload)
                if path == '/api/generate': r[field]=value
                return r
            with self.subTest(field=field):
                self.assertFalse(audit.verdict(p,audit.review(p,amended))['safe'])
    def test_truncated_response_fails(self):
        p=self.prepare(); send,_=self.transport()
        def transport(path,payload=None):
            r=send(path,payload)
            if path=='/api/generate': r['done_reason']='length'
            return r
        self.assertFalse(audit.verdict(p,audit.review(p,transport))['safe'])
    def test_oversize_context_fails(self):
        p=self.prepare(); p['baseline']='\\'*4096; p['candidate']='\\'*4096; p['diff']='\\'*12000
        send,calls=self.transport(); self.assertEqual(audit.review(p,send),[]); self.assertEqual(len(calls),2)
    def test_no_overwrite(self):
        output=self.root/'verdict.json'; output.write_text('old')
        send,_=self.transport()
        with self.assertRaises(FileExistsError): audit.run(self.inputs,str(self.repo),str(output),send)
        self.assertEqual(output.read_text(),'old')
    def test_actual_utf8_baseline_exact_bytes_and_hash(self):
        original=(self.repo/'utils-sleep.ts').read_bytes()
        self.assertIn('—'.encode(),original)
        replacement=original.replace(b'setTimeout(resolve, ms)',b'setTimeout(resolve, Math.max(0, ms))')
        blob=self.git('rev-parse','HEAD:utils-sleep.ts').strip()
        p=self.prepare(path='utils-sleep.ts',base_blob=blob,candidate_b64=base64.b64encode(replacement).decode())
        self.assertEqual(p['baseline'].encode('utf-8'),original)
        self.assertEqual(p['candidate'].encode('utf-8'),replacement)
        self.assertEqual(p['candidate_sha256'],hashlib.sha256(replacement).hexdigest())
        self.assertIn('—',p['baseline']); self.assertIn('—',p['candidate'])
        send,_=self.transport(); self.assertTrue(audit.verdict(p,audit.review(p,send))['safe'])
    def test_unicode_invalid_and_special_tokens_rejected(self):
        for text in ('// \u202e', '// \u200b', '// \x85', '// <|im_start|>'):
            with self.subTest(text=text), self.assertRaises(Exception):
                self.prepare(candidate_b64=base64.b64encode(text.encode()).decode())
    def test_readme_append_only_policy(self):
        blob=self.git('rev-parse','HEAD:README.md').strip()
        def check(b): return self.prepare(path='README.md',base_blob=blob,candidate_b64=base64.b64encode(b).decode())
        self.assertEqual(check(b'Synthetic notes.\nMore safe notes.\n')['path'],'README.md')
        for b in (b'Replaced.\n', b'Synthetic notes.\nBad: text.\n', b'Synthetic notes.\n'+b'a'*1025):
            with self.subTest(b=b[:30]), self.assertRaises(Exception): check(b)
    def test_exact_prompt_token_count_fail_closed(self):
        p=self.prepare(); p['baseline']='x'*3000; p['candidate']='y'*3000; p['diff']='z'*3000
        for count in (1, 0, 999999, True, None):
            send,_=self.transport()
            def truncated(path, payload=None):
                r=send(path,payload)
                if path=='/api/generate': r['prompt_eval_count']=count
                return r
            with self.subTest(count=count): self.assertFalse(audit.verdict(p,audit.review(p,truncated))['safe'])
    def test_runtime_version_mismatch_fails_closed(self):
        p=self.prepare(); send,_=self.transport()
        def wrong(path,payload=None):
            if path=='/api/version': return {'version':'0.0.0'}
            return send(path,payload)
        self.assertEqual(audit.review(p,wrong),[])
    def test_bad_tokenizer_file_fails_closed(self):
        from unittest.mock import patch
        path=self.root/'bad.json'; path.write_text('{}')
        with patch.dict(os.environ,{'TOKENIZER_PATH':str(path)}):
            with self.assertRaises(Exception): audit.load_tokenizer()
            send,_=self.transport(); self.assertEqual(audit.review(self.prepare(),send),[])
    def test_http_deadline_interrupts_trickling_response(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                self.send_response(200); self.send_header('Content-Length','100'); self.end_headers()
                try:
                    for _ in range(20):
                        self.wfile.write(b'x'); self.wfile.flush(); time.sleep(.025)
                except (BrokenPipeError, ConnectionResetError): pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        prior=signal.getsignal(signal.SIGALRM)
        try:
            with patch.object(audit,'URL','http://127.0.0.1:'+str(server.server_port)), patch.object(audit,'HTTP_DEADLINE_SECONDS',.15):
                start=time.monotonic()
                with self.assertRaises(audit.AuditError): audit.http_json('/trickle')
                self.assertLess(time.monotonic()-start,1.0)
            self.assertEqual(signal.getsignal(signal.SIGALRM),prior)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.0,0.0))
        finally:
            server.shutdown(); server.server_close(); thread.join()
    def test_http_limits_and_cleanup_on_success_and_error(self):
        self.assertEqual(audit.HTTP_DEADLINE_SECONDS,300)
        prior=signal.getsignal(signal.SIGALRM)
        class Response:
            status=200
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self,n): return b'{"ok":true}'
        class Opener:
            def open(self, req, timeout):
                self_timeout.append(timeout)
                if fail[0]: raise OSError('offline')
                return Response()
        self_timeout=[]; fail=[False]
        with patch.object(audit.urllib.request,'build_opener',return_value=Opener()):
            self.assertEqual(audit.http_json('/api/version'),{'ok':True})
            fail[0]=True
            with self.assertRaises(OSError): audit.http_json('/api/tags')
        self.assertEqual(self_timeout,[300,300])
        self.assertEqual(signal.getsignal(signal.SIGALRM),prior)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.0,0.0))
    def test_existing_timer_or_non_main_thread_fails_closed(self):
        previous=signal.getsignal(signal.SIGALRM)
        signal.setitimer(signal.ITIMER_REAL,10)
        try:
            with self.assertRaises(audit.AuditError): audit.http_json('/api/version')
            self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0],0)
            self.assertEqual(signal.getsignal(signal.SIGALRM),previous)
        finally: signal.setitimer(signal.ITIMER_REAL,0)
        results=[]
        def call():
            try: audit.http_json('/api/version')
            except Exception as exc: results.append(type(exc))
        t=threading.Thread(target=call); t.start(); t.join()
        self.assertEqual(results,[ValueError])
        self.assertEqual(signal.getsignal(signal.SIGALRM),previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.0,0.0))
    def test_timeout_at_every_call_fails_closed(self):
        p=self.prepare()
        for failing in range(5):
            send,calls=self.transport()
            def timed(path,payload=None):
                if len(calls)==failing: raise TimeoutError('synthetic timeout')
                return send(path,payload)
            votes=audit.review(p,timed,tokenizer=self.tokenizer)
            with self.subTest(failing=failing):
                self.assertEqual(len(votes),max(0,failing-2))
                self.assertFalse(audit.verdict(p,votes)['safe'])
    def test_pinned_evaluator_is_ancestor_of_checked_out_branch(self):
        # A local object or another branch is not enough: a squash/rebase can
        # leave the pinned SHA unavailable after the review branch is deleted.
        workflow=(HERE.parent/'.github/workflows/dashboard-auditor.yml').read_text()
        checkout=workflow.split('      - name: Check out pinned evaluator\n',1)[1].split('      - name:',1)[0]
        pin=re.search(r'^          ref: ([0-9a-f]{40})$',checkout,re.M).group(1)
        result=subprocess.run(['git','-C',str(HERE.parent),'merge-base','--is-ancestor',pin,'HEAD'])
        self.assertEqual(result.returncode,0,'Pinned evaluator must be retained in branch history; do not squash or rebase')
    def test_unpinned_candidate_cli_offline(self):
        # This exercises the modified worktree, not the still-pinned workflow.
        requests = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def reply(self, obj):
                body=json.dumps(obj).encode(); self.send_response(200); self.end_headers(); self.wfile.write(body)
            def do_GET(self):
                if self.path == '/api/version': self.reply({'version':audit.RUNTIME_VERSION})
                else: self.reply({'models':[{'name':audit.MODEL,'digest':audit.MODEL_DIGEST}]})
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                self.reply({'model':audit.MODEL,'done':True,'done_reason':'stop',
                            'prompt_eval_count':len(AuditTests.tokenizer.encode(body['prompt'],add_special_tokens=False).ids),
                            'response':'{"safe":true}'})
        server=http.server.HTTPServer(('127.0.0.1',11434),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            candidate=b'export const value = 2;'
            output=self.root/'verdict.json'
            env=os.environ.copy(); env.update({'NONCE':self.inputs['nonce'],'PATCH_PATH':self.inputs['path'],
                'BASE_BLOB':self.inputs['base_blob'],'CANDIDATE_B64':base64.b64encode(candidate).decode(),
                'WORKFLOW_SHA':self.sha,'RUN_ID':'123','RUN_ATTEMPT':'1','BASE_REPO':str(self.repo),'VERDICT_FILE':str(output)})
            for args in (['--validate'], []):
                proc=subprocess.run([sys.executable,str(HERE/'audit.py'),*args],env=env,capture_output=True,text=True,timeout=20)
                self.assertEqual(proc.returncode,0,proc.stdout+proc.stderr)
                self.assertNotIn('export const',proc.stdout+proc.stderr)
            result=json.loads(output.read_text())
            self.assertTrue(result['safe']); self.assertEqual(result['candidate_sha256'],hashlib.sha256(candidate).hexdigest())
            self.assertEqual(len(requests),3)
            for body in requests:
                data=body['prompt'].split('Untrusted JSON data follows:\n',1)[1].split('<|im_end|>',1)[0]
                record=json.loads(data)
                self.assertEqual(record['candidate'].encode(),candidate)
                self.assertIn('\\ No newline at end of file',record['diff'])
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_cli_http_integration_and_private_logs(self):
        requests=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                requests.append(('GET',self.path,None))
                if self.path == '/api/version': self.reply({'version':audit.RUNTIME_VERSION})
                else: self.reply({'models':[{'name':audit.MODEL,'digest':audit.MODEL_DIGEST}]})
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(('POST',self.path,body))
                self.reply({'model':audit.MODEL,'done':True,'done_reason':'stop',
                            'prompt_eval_count':len(AuditTests.tokenizer.encode(body['prompt'],add_special_tokens=False).ids),'response':'{"safe":true}'})
            def reply(self, obj):
                b=json.dumps(obj).encode(); self.send_response(200); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
        server=http.server.HTTPServer(('127.0.0.1',11434),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            output=self.root/'dashboard-audit-verdict.json'
            env=os.environ.copy(); env.update({'NONCE':self.inputs['nonce'],'PATCH_PATH':self.inputs['path'],
                'BASE_BLOB':self.inputs['base_blob'],'CANDIDATE_B64':self.inputs['candidate_b64'],
                'WORKFLOW_SHA':self.sha,'RUN_ID':'123','RUN_ATTEMPT':'1','BASE_REPO':str(self.repo),'VERDICT_FILE':str(output)})
            # Execute the exact validation and review commands from the workflow,
            # against a temporary workspace and mocked local Ollama HTTP server.
            workflow=(HERE.parent/'.github/workflows/dashboard-auditor.yml').read_text()
            commands=re.findall(r'^        run: (python3 evaluator/auditor/audit.py(?: --validate)?)$', workflow, re.M)
            self.assertEqual(commands,['python3 evaluator/auditor/audit.py --validate','python3 evaluator/auditor/audit.py'])
            checkout=workflow.split('      - name: Check out pinned evaluator\n',1)[1].split('      - name:',1)[0]
            pin=re.search(r'^          ref: ([0-9a-f]{40})$',checkout,re.M).group(1)
            subprocess.run(['git','clone','-q','--no-hardlinks','--no-checkout',str(HERE.parent),str(self.root/'evaluator')],check=True)
            subprocess.run(['git','-C',str(self.root/'evaluator'),'checkout','-q','--detach',pin],check=True)
            verify=workflow.split('      - name: Verify evaluator commit and file\n        run: |\n',1)[1].split('      # Never execute',1)[0]
            import textwrap
            verify=textwrap.dedent(verify)
            self.assertEqual(subprocess.run(['bash','-c',verify],cwd=self.root).returncode,0)
            evaluator=self.root/'evaluator/auditor/audit.py'
            pinned_bytes=subprocess.check_output(['git','-C',str(HERE.parent),'show',pin+':auditor/audit.py'])
            self.assertEqual(evaluator.read_bytes(),pinned_bytes)
            self.assertEqual(pinned_bytes,(HERE/'audit.py').read_bytes(), 'Pinned evaluator must match source on branch')
            # Exercise both the pinned checkout and the matching source.
            for executable in (str(evaluator), str(HERE/'audit.py')):
                requests.clear()
                if output.exists(): output.unlink()
                for command in commands:
                    command=command.replace('evaluator/auditor/audit.py',executable)
                    p=subprocess.run(command,shell=True,cwd=self.root,env=env,capture_output=True,text=True,timeout=20)
                    self.assertEqual(p.returncode,0,command + ': ' + p.stdout + p.stderr)
                result=json.loads(output.read_text())
                self.assertTrue(result['safe']); self.assertEqual(len(requests),5)
                self.assertEqual(result['providers'],list(audit.PROVIDERS))
                self.assertEqual(set(result),{'base_blob','candidate_sha256','nonce','path','run_attempt','run_id','workflow_sha','job','version','safe','providers'})
                self.assertEqual(result['version'],1)
                self.assertNotIn('export const',p.stdout+p.stderr+output.read_text())
                for method,path,body in requests[2:]:
                    self.assertEqual((method,path),('POST','/api/generate'))
                    self.assertIn('export const value = 1',body['prompt']); self.assertIn('export const value = 2',body['prompt'])
        finally:
            server.shutdown(); server.server_close(); thread.join()

if __name__ == '__main__': unittest.main(verbosity=2)
