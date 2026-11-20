import importlib.util
import pathlib
import time
import unittest
from timing_probe import wrap_transport

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('audit', ROOT.parents[3]/'auditor/audit.py')
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)
class Encoded: ids = [1,2,3]
class Tokenizer:
    def encode(self, *a, **kw): return Encoded()
P = {'path':'sample.ts','base_blob':'a'*40,'candidate_sha256':'b'*64,'baseline':'TOP_SECRET_MARKER','candidate':'PRIVATE_CANDIDATE','diff':'PRIVATE_DIFF','nonce':'c'*64,'run_attempt':1,'run_id':'1','workflow_sha':'d'*40}
def mock(fail=None, delay=0):
    calls=[]
    def send(path, payload=None):
        i=len(calls); calls.append(path); time.sleep(delay)
        if i == fail: raise TimeoutError('PRIVATE_ERROR_MARKER')
        if i == 0: return {'version':audit.RUNTIME_VERSION}
        if i == 1: return {'models':[{'name':audit.MODEL,'digest':audit.MODEL_DIGEST}]}
        return {'model':audit.MODEL,'done':True,'done_reason':'stop','prompt_eval_count':3,'response':'{"safe":true}'}
    return send,calls
class TimingTests(unittest.TestCase):
    def test_all_three_votes_unchanged_no_sensitive_output(self):
        send,calls=mock(delay=.01); events=[]
        votes=audit.review(P,wrap_transport(send,events.append),tokenizer=Tokenizer())
        self.assertTrue(audit.verdict(P,votes)['safe']); self.assertEqual(len(calls),5)
        self.assertEqual([x['phase'] for x in events],['version','tags','vote_security','vote_correctness','vote_intent'])
        self.assertEqual([x['outcome'] for x in events],['ok']*5)
        self.assertTrue(all(x['elapsed_ms']>=9 for x in events)); self.assertNotIn('PRIVATE',repr(events)); self.assertNotIn('SECRET',repr(events))
    def test_each_transport_timeout_fail_closed(self):
        for failing in range(5):
            with self.subTest(failing=failing):
                send,calls=mock(failing); events=[]
                votes=audit.review(P,wrap_transport(send,events.append),tokenizer=Tokenizer())
                self.assertFalse(audit.verdict(P,votes)['safe']); self.assertEqual(len(calls),failing+1)
                self.assertEqual(events[-1]['outcome'],'error'); self.assertNotIn('PRIVATE_ERROR',repr(events))
    def test_sink_failure_does_not_approve_failure_or_hide_votes(self):
        def badsink(_): raise RuntimeError('ignored')
        for failing in (None,2):
            send,_=mock(failing)
            result=audit.verdict(P,audit.review(P,wrap_transport(send,badsink),tokenizer=Tokenizer()))
            self.assertEqual(result['safe'],failing is None)
    def test_unexpected_path_does_not_log_arbitrary_data(self):
        events=[]; wrapped=wrap_transport(lambda path,payload: 'ok',events.append)
        self.assertEqual(wrapped('PRIVATE_PATH','PRIVATE_PAYLOAD'),'ok'); self.assertEqual(events,[])
if __name__=='__main__': unittest.main()
