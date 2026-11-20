import base64
import hashlib
import json
import multiprocessing as mp
import os
import sqlite3
import subprocess
import tempfile
import unittest
from journal import Journal, REPO

KEY = b'k' * 32

def binding():
    return dict(repository=REPO, branch='main', filename='src/private-name.js',
                base='a'*40, blob='b'*40, mode='100644',
                content='private candidate', audit_nonce='d'*64)

def racer(path, q, go):
    j = Journal(path, KEY)
    go.wait()
    try:
        j.reserve(binding(), 'receipt-' + str(os.getpid()))
        q.put('reserved')
    except sqlite3.IntegrityError:
        q.put('locked')
    finally:
        j.close()

def crasher(path, pipe, acknowledged):
    j = Journal(path, KEY)
    op = j.reserve(binding(), 'crash-receipt')
    if acknowledged:
        j.acknowledge(op, binding(), 'c'*40, lambda *_: True)
    pipe.send(op)
    os._exit(0)

def synthetic_objects():
    objects = {}
    def put(kind, data):
        oid=hashlib.sha1((kind+' '+str(len(data))+'\0').encode()+data).hexdigest()
        objects[oid]={'type':kind, 'data':base64.b64encode(data).decode()}
        return oid
    def tree(entries):
        return put('tree', b''.join((mode+' '+name+'\0').encode()+bytes.fromhex(oid) for mode,name,oid in entries))
    old=put('blob', b'old'); new=put('blob', b'private candidate')
    olddir=tree([('100644','private-name.js',old)]); newdir=tree([('100644','private-name.js',new)])
    oldroot=tree([('40000','src',olddir)]); newroot=tree([('40000','src',newdir)])
    def commit(root, parent=''):
        return put('commit', ('tree '+root+'\n'+('parent '+parent+'\n' if parent else '')+'author X <x@x> 1 +0000\ncommitter X <x@x> 1 +0000\n\nmock\n').encode())
    base=commit(oldroot); after=commit(newroot,base)
    return objects,base,old,after

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temp.name, 'journal.sqlite')
        self.j = Journal(self.path, KEY)
        self.b = binding()
    def tearDown(self):
        self.j.close()
        self.temp.cleanup()
    def reserve(self):
        return self.j.reserve(self.b, 'secret receipt')
    def ack(self, op, commit='c'*40):
        self.j.acknowledge(op, self.b, commit, lambda o,b,c: True)
    def test_restart_before_send_locks_and_is_unresolved(self):
        op = self.reserve(); self.j.close(); self.j = Journal(self.path, KEY)
        self.assertEqual(self.j.recover(op, self.b, lambda b,c: True), 'unresolved')
        with self.assertRaises(sqlite3.IntegrityError): self.j.reserve(self.b, 'another receipt')
    def test_lost_response_after_send_cannot_use_matching_head(self):
        op = self.reserve(); calls = []
        self.assertEqual(self.j.recover(op, self.b, lambda b,c: calls.append(c) or True), 'unresolved')
        self.assertEqual(calls, [])
    def test_restart_after_ack_recovers_and_receipt_remains_consumed(self):
        op = self.reserve(); self.ack(op); self.j.close(); self.j = Journal(self.path, KEY)
        self.assertEqual(self.j.recover(op, self.b, lambda b,c: c == 'c'*40), 'committed')
        self.assertEqual(self.j.recover(op, self.b, lambda b,c: False), 'committed')
        with self.assertRaises(sqlite3.IntegrityError): self.j.reserve(self.b, 'secret receipt')
        self.j.reserve(self.b, 'new receipt')
    def test_untrusted_and_wrong_response_do_not_unlock(self):
        op = self.reserve()
        with self.assertRaises(ValueError): self.j.acknowledge(op, self.b, 'c'*40, lambda *_: False)
        with self.assertRaises(ValueError): self.j.acknowledge(op, self.b, 'c'*39, lambda *_: True)
        self.assertEqual(self.j.recover(op, self.b, lambda *_: True), 'unresolved')
    def test_binding_and_commit_cannot_be_substituted(self):
        op = self.reserve(); wrong = {**self.b, 'content':'different'}
        with self.assertRaises(ValueError): self.j.acknowledge(op, wrong, 'c'*40, lambda *_: True)
        self.ack(op)
        with self.assertRaises(ValueError): self.j.recover(op, wrong, lambda *_: True)
        with self.assertRaises(ValueError): self.ack(op, 'f'*40)
        self.assertEqual(self.j.recover(op, self.b, lambda b,c: c=='f'*40), 'unresolved')
    def test_verifier_false_or_exception_retains_lock(self):
        op = self.reserve(); self.ack(op)
        self.assertEqual(self.j.recover(op, self.b, lambda *_: False), 'unresolved')
        def boom(*_): raise RuntimeError('offline')
        with self.assertRaises(RuntimeError): self.j.recover(op, self.b, boom)
        with self.assertRaises(sqlite3.IntegrityError): self.j.reserve(self.b, 'new receipt')
    def test_no_persisted_private_input_or_receipt(self):
        op = self.reserve(); self.ack(op)
        self.j.close()
        with open(self.path, 'rb') as f: data = f.read()
        for secret in [b'src/private-name.js', b'private candidate', b'secret receipt', KEY, b'Maka-opsol/Automa-bot']:
            self.assertNotIn(secret, data)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.j = Journal(self.path, KEY)
    def test_parallel_processes_one_branch_one_reservation(self):
        self.j.close()
        ctx=mp.get_context('spawn'); q=ctx.Queue(); go=ctx.Event()
        ps=[ctx.Process(target=racer,args=(self.path,q,go)) for _ in range(5)]
        for p in ps: p.start()
        go.set()
        values=[q.get(timeout=10) for _ in ps]
        for p in ps: p.join(10); self.assertEqual(p.exitcode,0)
        self.assertEqual(values.count('reserved'),1)
        self.assertEqual(values.count('locked'),4)
        self.j = Journal(self.path, KEY)
    def test_database_failure_never_releases_lock(self):
        op=self.reserve(); self.ack(op)
        self.j.db.execute("CREATE TRIGGER fail_release BEFORE DELETE ON locks BEGIN SELECT RAISE(ABORT, 'blocked'); END")
        with self.assertRaises(sqlite3.IntegrityError): self.j.recover(op,self.b,lambda *_: True)
        self.assertEqual(self.j.db.execute('SELECT state FROM records WHERE operation=?',(op,)).fetchone()[0], 'acknowledged')
        with self.assertRaises(sqlite3.IntegrityError): self.j.reserve(self.b, 'new')
    def test_abrupt_process_death_recovers_only_acknowledged(self):
        self.j.close()
        ctx=mp.get_context('spawn'); read,write=ctx.Pipe(False)
        p=ctx.Process(target=crasher,args=(self.path,write,True)); p.start()
        op=read.recv(); p.join(10); self.assertEqual(p.exitcode,0)
        self.j=Journal(self.path,KEY)
        self.assertEqual(self.j.recover(op,self.b,lambda *_: True), 'committed')
    def test_synthetic_git_objects_recovery_with_actual_verifier(self):
        objects,base,old,after=synthetic_objects()
        b={**self.b,'base':base,'blob':old}
        op=self.j.reserve(b,'synthetic-receipt')
        self.j.acknowledge(op,b,after,lambda *_: True)
        def verify(binding,commit):
            p=subprocess.run(['node','mock_verify.js'],input=json.dumps(dict(binding=binding,commit=commit,objects=objects)),text=True,capture_output=True,check=True)
            return p.stdout=='true'
        bad=dict(objects); bad.pop(old)
        def verify_missing(binding,commit):
            p=subprocess.run(['node','mock_verify.js'],input=json.dumps(dict(binding=binding,commit=commit,objects=bad)),text=True,capture_output=True,check=True)
            return p.stdout=='true'
        self.assertEqual(self.j.recover(op,b,verify_missing),'unresolved')
        self.assertEqual(self.j.recover(op,b,verify),'committed')
    def test_bad_binding_rejected(self):
        for field, val in [('base','HEAD'), ('blob','z'*40), ('branch','other'), ('filename','../x'), ('content','\ud800'), ('audit_nonce','short')]:
            bad = {**self.b, field:val}
            with self.subTest(field=field), self.assertRaises((ValueError, UnicodeError)): self.j.reserve(bad, 'new')

if __name__ == '__main__': unittest.main(verbosity=2)
