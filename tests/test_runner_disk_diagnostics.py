#!/usr/bin/env python3
"""Offline synthetic tests: no bot, Actions, network, or real credentials."""
import os, pathlib, re, subprocess, tempfile, unittest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/runner-disk-diagnostics.sh'
WORKFLOW = ROOT / '.github/workflows/mathu-bot-loop.yml'

class Diagnostics(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.workspace = self.root / 'PRIVATE_path_name'
        self.workspace.mkdir()
        (self.workspace / 'PRIVATE_filename').write_text('PRIVATE_CONTENT')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ, GITHUB_WORKSPACE=str(self.workspace),
                        PATH=str(self.bin) + ':/usr/bin:/bin', TOP_SECRET='PRIVATE_SECRET')

    def fake(self, name, text):
        p = self.bin / name
        p.write_text('#!/bin/bash\n' + text + '\n')
        p.chmod(0o755)

    def run_report(self):
        return subprocess.run(['/bin/bash', str(SCRIPT), '--once'], env=self.env,
                              capture_output=True, text=True, timeout=25)

    def test_synthetic_workspace_private(self):
        r = self.run_report()
        self.assertEqual(r.returncode, 0)
        self.assertRegex(r.stdout, r'workspace kib [0-9]+')
        self.assertNotIn('PRIVATE', r.stdout + r.stderr)
        self.assertNotIn(str(self.workspace), r.stdout + r.stderr)

    def test_missing_workspace(self):
        self.env['GITHUB_WORKSPACE'] = str(self.root / 'nonexistent')
        r = self.run_report()
        self.assertEqual(r.returncode, 0)
        self.assertIn('workspace unavailable', r.stdout)

    def test_du_failure_even_with_partial_output(self):
        self.fake('du', 'printf "999\\tPRIVATE_path\\n"; echo PRIVATE_error >&2; exit 1')
        r = self.run_report()
        self.assertEqual(r.returncode, 0)
        self.assertIn('workspace unavailable', r.stdout)
        self.assertNotIn('PRIVATE', r.stdout + r.stderr)

    def test_du_malformed_output_rejected(self):
        self.fake('du', 'printf "PRIVATE_leak\\tpath\\n"')
        r = self.run_report()
        self.assertIn('workspace unavailable', r.stdout)
        self.assertNotIn('PRIVATE', r.stdout + r.stderr)

    def test_df_failure_does_not_leak(self):
        self.fake('df', 'echo PRIVATE_path >&2; echo PRIVATE_output; exit 1')
        r = self.run_report()
        self.assertEqual(r.returncode, 0)
        self.assertIn('root blocks unavailable', r.stdout)
        self.assertIn('tmp inodes unavailable', r.stdout)
        self.assertNotIn('PRIVATE', r.stdout + r.stderr)

    def test_timed_out_commands_are_nonfatal(self):
        self.fake('timeout', 'echo PRIVATE_timed_out >&2; exit 124')
        r = self.run_report()
        self.assertEqual(r.returncode, 0)
        self.assertIn('root blocks unavailable', r.stdout)
        self.assertIn('workspace unavailable', r.stdout)
        self.assertNotIn('PRIVATE', r.stdout + r.stderr)

    def test_df_malformed_output_rejected(self):
        self.fake('df', 'echo "100 90 10 90% PRIVATE_path"')
        r = self.run_report()
        self.assertIn('root blocks unavailable', r.stdout)
        self.assertNotIn('PRIVATE', r.stdout + r.stderr)

    def test_valid_df_and_du(self):
        self.fake('df', 'printf "header\\n100 90 10 90%%\\n"')
        self.fake('du', 'printf "123\\tPRIVATE_path\\n"')
        r = self.run_report()
        self.assertIn('root blocks-kib total used available percent:', r.stdout)
        self.assertIn('root inodes total used available percent:', r.stdout)
        self.assertIn('workspace kib 123', r.stdout)
        self.assertNotIn('PRIVATE', r.stdout + r.stderr)

    def test_monitor_stops_on_sigterm(self):
        p = subprocess.Popen(['/bin/bash', str(SCRIPT), '--monitor'], env=self.env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            import time
            time.sleep(.3)
            p.terminate()
            p.wait(timeout=15)
            self.assertEqual(p.returncode, 0)
        finally:
            if p.poll() is None:
                p.kill(); p.wait()

class Workflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.w = yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)
        prior = subprocess.check_output(['git', 'show', '8a53a12e0c1f7ccf95de2a58f1231fdeabb4e556:.github/workflows/mathu-bot-loop.yml'], cwd=ROOT, text=True)
        cls.prior = yaml.load(prior, Loader=yaml.BaseLoader)

    def test_no_trigger_or_privilege_change(self):
        self.assertEqual(self.w['on'], self.prior['on'])
        self.assertEqual(set(self.w['on']), {'workflow_dispatch', 'repository_dispatch'})
        self.assertEqual(self.w['permissions'], self.prior['permissions'])
        self.assertEqual(self.w['jobs']['run-bot']['environment'], self.prior['jobs']['run-bot']['environment'])

    def test_existing_steps_preserved_except_monitor(self):
        steps = self.w['jobs']['run-bot']['steps']
        existing = [s for s in steps if not s.get('name', '').startswith('Runner disk')]
        previous = self.prior['jobs']['run-bot']['steps']
        for actual, old in zip(existing, previous):
            if actual.get('name') == 'Run MathU Bot':
                actual = dict(actual)
                start = actual['run'].index('# No bot credentials')
                end = actual['run'].index('./scripts/run-bot.sh', start)
                actual['run'] = actual['run'][:start] + actual['run'][end:]
            self.assertEqual(actual, old)
        self.assertEqual(len(existing), len(previous))

    def exercise_wiring(self, bot_status, diag_status):
        run = next(s['run'] for s in self.w['jobs']['run-bot']['steps'] if s.get('name') == 'Run MathU Bot')
        fragment = run[run.index('env -i PATH=/usr/bin:/bin', run.index('# No bot credentials')):]
        with tempfile.TemporaryDirectory() as tmp:
            d = pathlib.Path(tmp); (d/'scripts').mkdir()
            (d/'scripts/runner-disk-diagnostics.sh').write_text('printf "SECRET=%s\\n" "${TOP_SECRET-unset}"\nexit '+str(diag_status)+'\n')
            bot = d/'scripts/run-bot.sh'
            bot.write_text('#!/bin/bash\nsleep .3\nexit '+str(bot_status)+'\n'); bot.chmod(0o755)
            r = subprocess.run(['/bin/bash', '-e', '-c', fragment], cwd=d,
                               env=dict(os.environ, GITHUB_WORKSPACE=tmp, TOP_SECRET='PRIVATE_SECRET'),
                               capture_output=True, text=True, timeout=10)
            return r

    def test_monitor_receives_no_secret_and_failure_nonfatal(self):
        r = self.exercise_wiring(0, 55)
        self.assertEqual(r.returncode, 0)
        self.assertIn('SECRET=unset', r.stdout)
        self.assertNotIn('PRIVATE_SECRET', r.stdout + r.stderr)

    def test_bot_failure_status_preserved(self):
        r = self.exercise_wiring(37, 55)
        self.assertEqual(r.returncode, 37)
        self.assertIn('SECRET=unset', r.stdout)

if __name__ == '__main__': unittest.main(verbosity=2)
