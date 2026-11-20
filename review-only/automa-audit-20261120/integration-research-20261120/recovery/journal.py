"""OFFLINE model only. Never use as an actual GitHub or dashboard adapter.

All callbacks are trust boundaries. SQLite durability and a single-machine shared
filesystem are deployment assumptions, not properties established by these tests.
No transport, credential, dashboard, authentication or real provider is included.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3

REPO = 'Maka-opsol/Automa-bot'
HEX40 = re.compile(r'^[a-f0-9]{40}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')


def _pack(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()


class Journal:
    """One trusted journal/key domain for all writers; no production wiring."""
    def __init__(self, path, key):
        if not isinstance(key, bytes) or len(key) < 32:
            raise ValueError('key required')
        self.key = key
        # Model only: a real deployment needs hardened creation, ownership, backup,
        # rollback protection and verified cross-process filesystem semantics.
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        self.db = sqlite3.connect(path, timeout=5, isolation_level=None)
        self.db.execute('PRAGMA journal_mode=DELETE')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA secure_delete=ON')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS records (
            operation TEXT PRIMARY KEY, receipt TEXT NOT NULL UNIQUE,
            target TEXT NOT NULL, binding TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('reserved','acknowledged','committed')),
            commit_oid TEXT
          );
          CREATE TABLE IF NOT EXISTS locks (
            target TEXT PRIMARY KEY, operation TEXT NOT NULL UNIQUE
          );
        ''')

    def close(self):
        self.db.close()

    def _mac(self, domain, value):
        return hmac.new(self.key, domain.encode() + b'\0' + _pack(value), hashlib.sha256).hexdigest()

    def _check(self, binding):
        if not isinstance(binding, dict) or set(binding) != {'repository','branch','filename','base','blob','mode','content','audit_nonce'}:
            raise ValueError('binding shape')
        if binding['repository'] != REPO or binding['branch'] != 'main' or binding['mode'] != '100644':
            raise ValueError('target')
        path = binding['filename']
        if not isinstance(path, str) or len(path) > 1024 or not re.fullmatch(r'[A-Za-z0-9_./-]+', path) or any(not s or s.startswith('.') for s in path.split('/')):
            raise ValueError('path')
        if not isinstance(binding['base'], str) or not HEX40.fullmatch(binding['base']) or not isinstance(binding['blob'], str) or not HEX40.fullmatch(binding['blob']):
            raise ValueError('oid')
        if not isinstance(binding['audit_nonce'], str) or not HEX64.fullmatch(binding['audit_nonce']):
            raise ValueError('nonce')
        if not isinstance(binding['content'], str):
            raise ValueError('content')
        binding['content'].encode('utf-8', errors='strict')

    def reserve(self, binding, receipt_id):
        """Atomically consume a receipt and lock the whole branch before send.

        receipt_id MUST be a trusted authenticated receipt identifier, not user
        input. Caller must authenticate receipt against all binding fields first.
        A reserve error can be ambiguous: never send on a failed return.
        """
        self._check(binding)
        if not isinstance(receipt_id, str) or not receipt_id or len(receipt_id) > 1024:
            raise ValueError('receipt')
        op = secrets.token_hex(32)
        target = self._mac('branch', [binding['repository'], binding['branch']])
        receipt = self._mac('receipt', receipt_id)
        digest = self._mac('binding', binding)
        try:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('INSERT INTO records VALUES (?, ?, ?, ?, ?, NULL)', (op, receipt, target, digest, 'reserved'))
            self.db.execute('INSERT INTO locks VALUES (?, ?)', (target, op))
            self.db.execute('COMMIT')
        except BaseException:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise
        return op

    def acknowledge(self, op, binding, commit_oid, authenticate_response):
        """Persist authenticated operation provenance; NEVER infer from HEAD.

        Trusted transport verifier must bind original response to op, target,
        expected base and returned commit/parent. callback has no retry authority.
        """
        self._check(binding)
        if not isinstance(op, str) or not HEX64.fullmatch(op) or not isinstance(commit_oid, str) or not HEX40.fullmatch(commit_oid):
            raise ValueError('response identifiers')
        if authenticate_response(op, binding, commit_oid) is not True:
            raise ValueError('untrusted response')
        mac = self._mac('binding', binding)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            n = self.db.execute("UPDATE records SET state='acknowledged', commit_oid=? WHERE operation=? AND binding=? AND state='reserved'", (commit_oid, op, mac)).rowcount
            if n != 1:
                raise ValueError('state or binding')
            self.db.execute('COMMIT')
        except BaseException:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise

    def recover(self, op, binding, verify_immutable):
        """Read-only remote verification, then atomic terminal transition.

        No response provenance means unresolved even if HEAD looks identical.
        Caller must restore original trusted binding from a private source. The
        verifier must validate immutable full tree, parent, reviewed blob and bytes.
        """
        self._check(binding)
        if not isinstance(op, str) or not HEX64.fullmatch(op):
            raise ValueError('operation')
        mac = self._mac('binding', binding)
        row = self.db.execute('SELECT state, commit_oid, binding, target FROM records WHERE operation=?', (op,)).fetchone()
        if not row or not hmac.compare_digest(mac, row[2]):
            raise ValueError('unknown operation or binding')
        state, commit, _, target = row
        if state == 'committed':
            return 'committed'
        if state != 'acknowledged' or not commit:
            return 'unresolved'
        # Failure/exception must never release the lock. Callback is a trusted,
        # read-only verifier, not an audit aggregate or equality with HEAD.
        if verify_immutable(dict(binding), commit) is not True:
            return 'unresolved'
        self.db.execute('BEGIN IMMEDIATE')
        try:
            n = self.db.execute("UPDATE records SET state='committed' WHERE operation=? AND binding=? AND state='acknowledged' AND commit_oid=?", (op, mac, commit)).rowcount
            if n != 1:
                raise ValueError('state changed')
            n = self.db.execute('DELETE FROM locks WHERE target=? AND operation=?', (target, op)).rowcount
            if n != 1:
                raise ValueError('lock missing')
            self.db.execute('COMMIT')
        except BaseException:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise
        return 'committed'
