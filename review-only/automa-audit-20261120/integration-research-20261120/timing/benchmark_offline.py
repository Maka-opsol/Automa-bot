"""Single-process loopback mock; NOT model, GitHub runner or network benchmark."""
import http.server, importlib.util, json, os, pathlib, statistics, threading, time
from timing_probe import wrap_transport
from test_timing_probe import P
ROOT=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('audit',ROOT.parents[3]/'auditor/audit.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
# Set TOKENIZER_PATH to the pinned tokenizer file before running.
if not os.environ.get('TOKENIZER_PATH'): raise SystemExit('Set TOKENIZER_PATH to the verified pinned tokenizer JSON')
t=time.monotonic(); tok=audit.load_tokenizer(); print('local_real_pinned_tokenizer_load_s',round(time.monotonic()-t,4))
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  time.sleep(.04)
  self.respond({'version':audit.RUNTIME_VERSION} if self.path=='/api/version' else {'models':[{'name':audit.MODEL,'digest':audit.MODEL_DIGEST}]})
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  time.sleep(.04)
  self.respond({'model':audit.MODEL,'done':True,'done_reason':'stop','prompt_eval_count':len(tok.encode(body['prompt'],add_special_tokens=False).ids),'response':'{"safe":true}'})
 def respond(self,obj):
  data=json.dumps(obj).encode();self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
s=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler); thread=threading.Thread(target=s.serve_forever,daemon=True);thread.start();audit.URL='http://127.0.0.1:'+str(s.server_port)
try:
 totals=[]; phases=[]
 for n in range(5):
  events=[];start=time.monotonic();v=audit.review(P,wrap_transport(audit.http_json,events.append),tokenizer=tok);totals.append(time.monotonic()-start)
  assert audit.verdict(P,v)['safe'] and len(events)==5;phases.append([x['elapsed_ms'] for x in events])
 print('synthetic_per_call_delay_ms',40,'repetitions',len(totals),'calls_per_review',5,'votes',3)
 print('loopback_review_total_seconds', [round(x,4) for x in totals]);print('loopback_phases_ms',phases)
finally:s.shutdown();s.server_close();thread.join()
