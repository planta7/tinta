"""Regression tests for the public consistency checker; no language execution."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('check_spec', ROOT/'scripts/check_spec.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class PublicChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'source'
        for source in checker.source_files():
            destination = self.root/source.relative_to(ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)

    def run_check(self, success=True, *args):
        result = subprocess.run([sys.executable, str(self.root/'scripts/check_spec.py'), *args],
                                cwd=self.temp.name, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def edit_json(self, name, edit):
        path = self.root/name
        value = json.loads(path.read_text())
        edit(value)
        path.write_text(json.dumps(value))

    def test_clean_copy_and_read_only(self):
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.run_check()
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse((self.root/'.git').exists())

    def test_unrelated_invalid_json_is_ignored(self):
        for folder in ('.local', 'reports', 'node_modules', 'scratch'):
            p = self.root/folder/'invalid.json'; p.parent.mkdir(); p.write_text('{bad')
        self.run_check()

    def test_missing_required_file(self):
        (self.root/'spec/grammar.ebnf').unlink()
        self.run_check(False)

    def test_invalid_registry(self):
        (self.root/'spec/registry.json').write_text('{bad')
        self.run_check(False)

    def test_strict_json(self):
        for text in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}'):
            with self.subTest(text=text):
                (self.root/'spec/extra.json').write_text(text)
                self.run_check(False)

    def test_missing_link_and_anchor(self):
        p = self.root/'README.md'; original = p.read_text()
        for target in ('missing.md', 'DECISIONS.md#missing-heading'):
            with self.subTest(target=target):
                p.write_text(original+'\n[Reference]('+target+')\n')
                self.run_check(False)
        p.write_text(original+'\n[Reference](README.md#status)\n'); self.run_check()

    def test_nonpublic_existing_target(self):
        (self.root/'local-notes.md').write_text('# Notes\n')
        with (self.root/'README.md').open('a') as f:
            f.write('\n[Reference](local-notes.md)\n')
        self.run_check(False)

    def test_external_symlink_is_not_followed(self):
        external = Path(self.temp.name)/'external.json'; external.write_text('{bad')
        (self.root/'spec/external.json').symlink_to(external)
        self.run_check()
        (self.root/'spec/registry.json').unlink()
        (self.root/'spec/registry.json').symlink_to(ROOT/'spec/registry.json')
        self.run_check(False)

    def test_requirement_authority(self):
        self.edit_json('conformance/requirements.json', lambda d: d['requirements'][0].update(authority='missing.md'))
        self.run_check(False)

    def test_snapshot_hash(self):
        self.edit_json('examples/article.tinta.state.json', lambda d: d.update(sourceSha256='0'*64))
        self.run_check(False)

    def test_malformed_bundle(self):
        (self.root/'examples/local-image.tinta.zip').write_bytes(b'not a zip')
        self.run_check(False)

    def test_bundle_member_integrity(self):
        path = self.root/'examples/local-image.tinta.zip'
        with zipfile.ZipFile(path) as z:
            members = [(i,z.read(i)) for i in z.infolist()]
        with zipfile.ZipFile(path,'w') as z:
            for info,body in members:
                z.writestr(info,body+b'changed' if info.filename == 'document.tinta' else body)
        self.run_check(False)

    def test_identity_agreement(self):
        self.run_check()
        self.edit_json('schemas/state.schema.json',lambda d: d['properties']['kind'].update(const='wrong-state'))
        self.run_check(False)

    def test_profile_agreement(self):
        self.edit_json('spec/registry.json',lambda d: d.update(profiles=['markdown','unknown']))
        self.run_check(False)

    def test_diagnostic_reference(self):
        self.edit_json('conformance/cases.json',lambda d: d['cases'][0]['expect'].update(code='E_UNREGISTERED'))
        self.run_check(False)

    def test_seed_ids_and_assertions(self):
        for filename,prefix,count in [('cases','CT',98),('scenarios','SC',46)]:
            data=json.loads((self.root/('conformance/'+filename+'.json')).read_text())
            self.assertEqual([r['id'] for r in data[filename]], [f'{prefix}-{i:03}' for i in range(1,count+1)])
            self.assertEqual(data['executionStatus'],'NOT_RUN')
            self.assertTrue(all(r['status']=='NOT_RUN' for r in data[filename]))
        # Preserve every seed assertion and procedure across an identifier-only revision.
        # Deliberate future semantic changes require reviewing this compatibility guard.
        records = json.loads((self.root/'conformance/cases.json').read_text())['cases']
        self.assertEqual(hashlib.sha256(json.dumps(records,sort_keys=True,ensure_ascii=False).encode()).hexdigest(), '24450f68dbc3fd1846e7b2c39b65b4f29798b37589399f143e6069d195fa5fc4')
        records = json.loads((self.root/'conformance/scenarios.json').read_text())['scenarios']
        self.assertEqual(hashlib.sha256(json.dumps(records,sort_keys=True,ensure_ascii=False).encode()).hexdigest(), 'a24ae965818d1065e4ab7a3975f40f0a8ff094e8c9ff115ae236f2bcb724cfb8')
        self.edit_json('conformance/cases.json',lambda d: d['cases'].pop())
        self.run_check(False)

    def test_explicit_report_and_no_overwrite(self):
        report=Path(self.temp.name)/'result.json'
        self.run_check(True,'--report',str(report))
        self.assertEqual(json.loads(report.read_text())['status'],'PASS')
        original=(self.root/'spec/registry.json').read_bytes()
        self.run_check(False,'--report',str(self.root/'spec/registry.json'))
        self.assertEqual((self.root/'spec/registry.json').read_bytes(),original)

    def test_contract_prerequisites_fail_explicitly(self):
        result = subprocess.run([sys.executable, '-S', str(self.root/'scripts/check_contracts.py')],
                                cwd=self.temp.name, env=dict(os.environ, PATH=''),
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('NOT_RUN', result.stdout)
        self.assertIn('typescript-prerequisite', result.stdout)
        self.assertNotIn('Traceback', result.stderr)

    def test_obsolete_option_is_rejected(self):
        self.run_check(False,'--refresh-manifest')


if __name__ == '__main__':
    unittest.main()
