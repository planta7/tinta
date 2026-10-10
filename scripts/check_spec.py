#!/usr/bin/env python3
"""Check public specification consistency using Python's standard library.
This does not execute the Tinta language or validate runtime conformance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import struct
import sys
import zlib
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote
from zipfile import ZipFile, BadZipFile

ROOT = Path(__file__).resolve().parents[1]
REPORT = None
PUBLIC_ROOTS = (
    'architecture',
    'spec',
    'contracts',
    'schemas',
    'conformance',
    'examples',
    'docs',
    'decisions',
    'scripts',
    'patches',
    'third_party',
    'toolchain',
)
PUBLIC_TOP = (
    'README.md',
    'CONTRIBUTING.md',
    'DECISIONS.md',
    'LICENSE',
    'SECURITY.md',
    '.gitignore',
)
checks: list[dict[str, object]] = []


def record(name: str, ok: bool, detail: str = '') -> None:
    checks.append({'check': name, 'passed': bool(ok), 'detail': detail})


def unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    out: dict[str, object] = {}
    for key, val in pairs:
        if key in out:
            raise ValueError('Duplicate JSON key: ' + key)
        out[key] = val
    return out


def load(path: Path) -> object:
    return json.loads(
        path.read_text(encoding='utf-8'),
        object_pairs_hook=unique_pairs,
        parse_constant=lambda s: (_ for _ in ()).throw(
            ValueError('Non-finite JSON ' + s)
        ),
    )


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_files() -> list[Path]:
    paths = [
        ROOT / name
        for name in PUBLIC_TOP
        if (ROOT / name).is_file() and not (ROOT / name).is_symlink()
    ]
    for name in PUBLIC_ROOTS:
        base = ROOT / name
        if base.is_symlink():
            continue
        for p in base.rglob('*'):
            if p.is_file() and not any(
                part.is_symlink()
                for part in [p, *p.parents]
                if part != ROOT.parent
            ):
                if '__pycache__' not in p.parts and p.suffix != '.pyc':
                    paths.append(p)
    return sorted(paths)


def anchors(path: Path) -> set[str]:
    found = set()
    counts = {}
    for title in re.findall(
        r'^#{1,6} +(.+?)(?: +#+)?$', stripped_code(path.read_text(encoding='utf-8')), re.M
    ):
        slug = re.sub(r'[^\w\- ]', '', title.lower()).replace(' ', '-')
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        found.add(slug + ('-' + str(count) if count else ''))
    return found


def stripped_code(text: str) -> str:
    result = []
    fence = None
    for line in text.splitlines():
        m = re.match(r'^\s*(`{3,}|~{3,})', line)
        if m:
            token = m.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence is None:
            result.append(line)
    return '\n'.join(result)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--report',
        type=Path,
        help='Optional JSON output; default is stdout only.',
    )
    args = parser.parse_args()
    global REPORT
    REPORT = args.report
    public = set(source_files())
    required = list(PUBLIC_TOP) + [
        'spec/registry.json',
        'spec/grammar.ebnf',
        'contracts/public-api.d.ts',
        'contracts/worker-protocol.d.ts',
        'contracts/CONTRACT_RULES.md',
        'docs/CHEATSHEET.md',
        'docs/SOURCES.md',
        'conformance/cases.json',
        'conformance/scenarios.json',
        'conformance/requirements.json',
        'conformance/README.md',
        'conformance/TRACEABILITY.md',
        'architecture/STACK.md',
        'architecture/MODULES.md',
        'examples/README.md',
        'examples/article.tinta.state.json',
        'examples/local-image.tinta.zip',
        *[
            'examples/' + n + '.tinta'
            for n in (
                'minimal',
                'article',
                'report',
                'guide',
                'chart-atlas',
                'all-functions',
                'local-image',
                'import-after',
            )
        ],
        'examples/import-before.md',
        *[
            'schemas/' + n + '.schema.json'
            for n in ('bundle', 'state', 'import', 'interactive-envelope')
        ],
        *[
            'spec/' + n
            for n in (
                '00_OVERVIEW.md',
                '01_MARKDOWN_AND_LEXING.md',
                '02_EXPRESSIONS_AND_STATE.md',
                '03_DIRECTIVES.md',
                '04_DATA.md',
                '05_CHARTS.md',
                '06_LIMITS_AND_DIAGNOSTICS.md',
            )
        ],
        *[
            'docs/' + n
            for n in (
                '01_PRODUCT.md',
                '02_FILES_AND_EXPORTS.md',
                '03_EDITOR_AND_READER.md',
                '04_SECURITY.md',
                '05_ACCESSIBILITY_AND_DESIGN.md',
                '06_CLI.md',
                '07_VERIFICATION.md',
                '08_CHANGE_CONTROL.md',
            )
        ],
    ]
    for name in required:
        record('required-file:' + name, (ROOT / name) in public)
    for p in sorted(p for p in public if p.suffix == '.json'):
        try:
            load(p)
            record('strict-json:' + p.relative_to(ROOT).as_posix(), True)
        except (ValueError, OSError) as exc:
            record('strict-json:' + str(p), False, str(exc))
    try:
        registry = load(ROOT / 'spec/registry.json')
        case_data = load(ROOT / 'conformance/cases.json')
        scenario_data = load(ROOT / 'conformance/scenarios.json')
        req_data = load(ROOT / 'conformance/requirements.json')
    except (ValueError, OSError) as exc:
        record('load-core-documents', False, str(exc))
        return finish({})

    for name, expected in [
        ('directives', 12),
        ('functions', 11),
        ('chartTypes', 7),
    ]:
        items = registry[name]
        record(
            'registry-count:' + name,
            len(items) == expected and len(set(items)) == expected,
        )
    expected_names = {
        'directives': {
            'meta',
            'let',
            'calc',
            'slider',
            'toggle',
            'choice',
            'when',
            'details',
            'data',
            'view',
            'table',
            'chart',
        },
        'functions': {
            'if',
            'min',
            'max',
            'round',
            'pow',
            'count',
            'sum',
            'mean',
            'fixed',
            'percent',
            'money',
        },
        'chartTypes': {
            'line',
            'area',
            'bar',
            'scatter',
            'pie',
            'donut',
            'histogram',
        },
    }
    for name, expected in expected_names.items():
        record('registry-names:' + name, set(registry[name]) == expected)
    record(
        'source-extension',
        registry['sourceExtension'] == '.tinta'
        and registry['bundleExtension'] == '.tinta.zip',
    )
    record(
        'limit-values',
        all(
            isinstance(v, int) and not isinstance(v, bool) and v > 0
            for v in registry['limits'].values()
        ),
    )
    for key in ('errors', 'warnings'):
        record(
            'diagnostic-registry:' + key,
            bool(registry[key])
            and all(
                re.fullmatch(('E_' if key == 'errors' else 'W_') + '[A-Z_]+', k)
                and isinstance(v, str)
                and bool(v)
                for k, v in registry[key].items()
            ),
        )
    grammar = (ROOT / 'spec/grammar.ebnf').read_text(encoding='utf-8')
    for name in registry['directives']:
        record('grammar-directive:' + name, '"@' + name + '"' in grammar)
    for name in registry['chartTypes']:
        record('grammar-chart:' + name, '"' + name + '"' in grammar)
    for p in sorted(p for p in public if p.suffix == '.md'):
        rel = p.relative_to(ROOT).as_posix()
        text = stripped_code(p.read_text(encoding='utf-8'))
        for target in re.findall(
            r'(?<!!)\[[^\]\n]*\]\(([^\s\)]+)(?:\s+"[^"]*")?\)', text
        ):
            if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', target):
                continue
            path, _, anchor = unquote(target).partition('#')
            dest = (p.parent / path).resolve() if path else p
            ok = dest in public
            if ok and anchor:
                ok = dest.suffix == '.md' and anchor in anchors(dest)
            record('relative-link:' + rel + ' -> ' + target, ok)
    cases = case_data['cases']
    scenarios = scenario_data['scenarios']
    reqs = req_data['requirements']
    ids = [x['id'] for x in cases + scenarios]
    record('case-ids-unique', len(ids) == len(set(ids)))
    record(
        'source-expectations-not-execution',
        'executionStatus' not in case_data
        and 'executionStatus' not in scenario_data
        and all(
            not {'status', 'milestone', 'manualRequired'}.intersection(x)
            for x in cases + scenarios
        )
        and all(
            not {'completeBy', 'implementationEvidence', 'coverageStatus'}.intersection(r)
            for r in reqs
        ),
    )
    record('seed-counts', len(cases) >= 98 and len(scenarios) >= 46)
    record(
        'seed-ids',
        {f'CT-{i:03}' for i in range(1, 99)} <= {c['id'] for c in cases}
        and {f'SC-{i:03}' for i in range(1, 47)}
        <= {c['id'] for c in scenarios},
    )
    record('requirement-ids-unique', len({r['id'] for r in reqs}) == len(reqs))
    for c in cases:
        record(
            'case-shape:' + c['id'],
            c['profile'] in registry['profiles']
            and c['phase']
            in ['compile', 'initial', 'transition', 'enrich', 'csv', 'json']
            and isinstance(c['expect']['ok'], bool),
        )
        for code in (
            [c['expect']['code']] if 'code' in c['expect'] else []
        ) + c['expect'].get('warningCodes', []):
            record(
                'case-diagnostic:' + c['id'] + ':' + code,
                code in registry['errors'] or code in registry['warnings'],
            )
    for scenario in scenarios:
        record(
            'scenario-shape:' + scenario['id'],
            all(
                isinstance(scenario[k], str) and bool(scenario[k])
                for k in ('procedure', 'expected', 'title')
            ),
        )
    covered = []
    for r in reqs:
        record(
            'requirement-authority:' + r['id'],
            (ROOT / r['authority']).resolve() in public,
        )
        refs = r['cases'] + r['scenarios']
        covered.extend(refs)
        record(
            'requirement-test-refs:' + r['id'],
            bool(refs) and all(i in ids for i in refs),
        )
    record('seed-traceability-total', set(covered) == set(ids))
    record('registry-profile', registry['profiles'] == ['markdown', 'tinta'])
    record(
        'registry-revision',
        registry['contractRevision'] == '1.0-draft.3'
        and registry['sourceVersion'] == '1.0'
        and registry['workingName'] == 'Tinta',
    )
    for name, kind in [
        ('bundle', 'tinta-source-bundle'),
        ('state', 'tinta-state'),
        ('import', 'tinta-import-schema'),
        ('interactive-envelope', 'tinta-interactive'),
    ]:
        schema = load(ROOT / ('schemas/' + name + '.schema.json'))
        record(
            'schema-kind:' + name, schema['properties']['kind']['const'] == kind
        )
    record(
        'schema-source-path',
        load(ROOT / 'schemas/bundle.schema.json')['properties']['source'][
            'properties'
        ]['path']['const']
        == 'document.tinta',
    )
    record(
        'schema-abi',
        load(ROOT / 'schemas/interactive-envelope.schema.json')['properties'][
            'abi'
        ]['const']
        == 'tinta-ir-1',
    )
    try:
        with ZipFile(ROOT / 'examples/local-image.tinta.zip') as z:
            record('fixture-zip-crc', z.testzip() is None)
            md = json.loads(
                z.read('manifest.json'),
                object_pairs_hook=unique_pairs,
                parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)),
            )
            record(
                'fixture-bundle-kind',
                md['kind'] == 'tinta-source-bundle'
                and md['formatVersion'] == '1.0'
                and md['source']['path'] == 'document.tinta',
            )
            record(
                'fixture-source-equality',
                z.read('document.tinta')
                == (ROOT / 'examples/local-image.tinta').read_bytes(),
            )
            record(
                'fixture-path-safety',
                all(
                    n in ('manifest.json', 'document.tinta')
                    or re.fullmatch(r'assets/[a-f0-9]{64}\.(png|jpg|webp)', n)
                    for n in z.namelist()
                ),
            )
            record(
                'fixture-canonical-metadata',
                z.comment == b''
                and all(
                    i.date_time == (1980, 1, 1, 0, 0, 0)
                    and i.compress_type == 0
                    and not i.extra
                    and not i.comment
                    and i.external_attr >> 16 == 0o100644
                    for i in z.infolist()
                ),
            )
            record(
                'fixture-canonical-order',
                z.namelist()
                == ['manifest.json', 'document.tinta']
                + sorted(a['path'] for a in md['assets']),
            )
            record(
                'fixture-canonical-json',
                z.read('manifest.json')
                == (json.dumps(md, sort_keys=True, indent=2) + '\n').encode(),
            )
            for asset in md['assets']:
                record(
                    'fixture-asset-reference:' + asset['path'],
                    asset['path'] in z.read('document.tinta').decode('utf-8')
                    and Path(asset['path']).stem == asset['sha256']
                    and z.read(asset['path'])
                    == (ROOT / 'examples' / asset['path']).read_bytes(),
                )
            expected = {'manifest.json', md['source']['path']} | {
                a['path'] for a in md['assets']
            }
            record(
                'fixture-zip-entry-set',
                set(z.namelist()) == expected
                and len(z.namelist()) == len(expected),
            )
            for f in [md['source']] + md['assets']:
                body = z.read(f['path'])
                record(
                    'fixture-zip-item:' + f['path'],
                    len(body) == f['bytes'] and digest(body) == f['sha256'],
                )
            png = z.read(md['assets'][0]['path'])
            record('fixture-png-signature', png[:8] == b'\x89PNG\r\n\x1a\n')
            pos = 8
            tags = []
            while pos < len(png):
                length = struct.unpack('>I', png[pos : pos + 4])[0]
                tag = png[pos + 4 : pos + 8]
                data = png[pos + 8 : pos + 8 + length]
                crc = struct.unpack(
                    '>I', png[pos + 8 + length : pos + 12 + length]
                )[0]
                record(
                    'fixture-png-chunk:' + tag.decode('ascii'),
                    crc == zlib.crc32(tag + data) & 0xFFFFFFFF,
                )
                tags.append(tag)
                pos += length + 12
            record(
                'fixture-png-complete',
                pos == len(png) and tags == [b'IHDR', b'IDAT', b'IEND'],
            )
        snapshot = load(ROOT / 'examples/article.tinta.state.json')
        record(
            'fixture-snapshot-kind',
            snapshot['kind'] == 'tinta-state'
            and snapshot['formatVersion'] == '1.0',
        )
        record(
            'fixture-snapshot-source-hash',
            snapshot['sourceSha256']
            == digest((ROOT / 'examples/article.tinta').read_bytes()),
        )
    except (OSError, ValueError, KeyError, struct.error, BadZipFile) as exc:
        record('fixture-integrity', False, str(exc))
    return finish(
        {
            'semanticCasesExpected': len(cases),
            'scenariosExpected': len(scenarios),
            'traceabilityAreas': len(reqs),
        }
    )


def finish(counts: dict[str, int]) -> int:
    failed = [c for c in checks if not c['passed']]
    report = {
        'kind': 'specification-consistency',
        'contractRevision': '1.0-draft.3',
        'checkedAtUTC': datetime.now(timezone.utc).isoformat(),
        'status': 'PASS' if not failed else 'FAIL',
        'scope': 'Public specification consistency only; no Tinta parser or runtime execution.',
        'runtimeTestsExecuted': False,
        'environment': {
            'python': platform.python_version(),
            'platform': platform.platform(),
        },
        'counts': {
            'checks': len(checks),
            'passed': len(checks) - len(failed),
            'failed': len(failed),
            **counts,
        },
        'checks': checks,
    }
    if REPORT is not None:
        target = REPORT.resolve()
        if target in set(source_files()):
            print(
                'Refusing to overwrite public input:', target, file=sys.stderr
            )
            return 1
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8',
        )
    print(
        f"Public specification: {report['status']} — {len(checks)-len(failed)}/{len(checks)} checks."
    )
    for item in failed:
        print('FAIL:', item['check'], item['detail'])
    print('No Tinta language/runtime tests were executed.')
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        code = main()
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        IndexError,
        struct.error,
        BadZipFile,
    ) as exc:
        record('public-input', False, str(exc))
        code = finish({})
    raise SystemExit(code)
