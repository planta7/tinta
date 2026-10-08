#!/usr/bin/env python3
"""Optional public type/schema checks, not runtime Tinta conformance.
Requires an installed tsc executable and Python jsonschema. M0 must repeat the
checks using its locked TypeScript and Ajv; the local tool version is recorded.
"""
from pathlib import Path
import json, platform, subprocess, sys, zipfile
from datetime import datetime, timezone
from importlib.metadata import version
import argparse
from check_spec import load, unique_pairs, source_files

ROOT=Path(__file__).resolve().parents[1]
checks=[]
def add(name,ok,detail=''):
    checks.append({'check':name,'passed':bool(ok),'detail':detail})
def command(args):
    try:
        p=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,timeout=45)
        return {'argv':args,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
    except (OSError,subprocess.TimeoutExpired) as exc:
        return {'argv':args,'exitCode':None,'stdout':'','stderr':str(exc)}
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    commands = []
    dependency_version = None
    try:
        from jsonschema import Draft202012Validator
        dependency_version = version('jsonschema')
    except ImportError as exc:
        add('schema-validator-prerequisite', False, 'NOT_RUN: Python jsonschema is required: ' + str(exc))
    if dependency_version is not None:
        try:
            cmd=['tsc','--noEmit','--strict','--exactOptionalPropertyTypes','--noUncheckedIndexedAccess',
                 '--target','ES2022','--lib','ES2022','--module','NodeNext','--moduleResolution','NodeNext',
                 'contracts/public-api.d.ts','contracts/worker-protocol.d.ts']
            ver=command(['tsc','--version']); result=command(cmd)
            commands.extend([ver,result])
            add('public-types-compile',result['exitCode']==0,result['stderr'] or result['stdout'])
            schemas={p.name:load(p) for p in source_files() if p.parent == ROOT/'schemas' and p.suffix == '.json'}
            for name,schema in schemas.items():
                try:
                    Draft202012Validator.check_schema(schema);add('schema-definition:'+name,True)
                except Exception as exc:
                    add('schema-definition:'+name,False,str(exc))
            state=load(ROOT/'examples/article.tinta.state.json')
            with zipfile.ZipFile(ROOT/'examples/local-image.tinta.zip') as z:
                bundle=json.loads(z.read('manifest.json'), object_pairs_hook=unique_pairs)
            positive=[('state',state,'state.schema.json'),('bundle',bundle,'bundle.schema.json'),
                      ('import',{'kind':'tinta-import-schema','columns':[{'input':'Name','name':'name','type':'text'}]},'import.schema.json')]
            for label,value,sch in positive:
                valid=Draft202012Validator(schemas[sch])
                add('positive-envelope:'+label,valid.is_valid(value))
                wrong=dict(value,unknown=True);add('reject-extra:'+label,not valid.is_valid(wrong))
                wrong=dict(value,kind='not-tinta');add('reject-kind:'+label,not valid.is_valid(wrong))
                wrong=dict(value);wrong.pop(next(iter(schemas[sch]['required'])))
                add('reject-missing:'+label,not valid.is_valid(wrong))
            sv=Draft202012Validator(schemas['state.schema.json'])
            for label,patch in [('hash',{'sourceSha256':'wrong'}),('version',{'formatVersion':'9.0'}),
                                ('null',{'controls':{'people':None}}),('array',{'controls':[]}),
                                ('object-answer',{'controls':{'people':{'value':5}}})]:
                add('reject-state-'+label,not sv.is_valid(dict(state,**patch)))
            bv=Draft202012Validator(schemas['bundle.schema.json'])
            for label,patch in [('version',{'formatVersion':'9.0'}),('assets-type',{'assets':{}}),
                                ('source-path',{'source':dict(bundle['source'],path='../document.tinta')}),
                                ('asset-path',{'assets':[dict(bundle['assets'][0],path='../evil.png')]}),
                                ('asset-mime',{'assets':[dict(bundle['assets'][0],mime='image/svg+xml')]})]:
                add('reject-bundle-'+label,not bv.is_valid(dict(bundle,**patch)))
            # Envelope validation is deliberately separate from the future IR decoder.
            from referencing import Registry, Resource
            resources = Registry().with_resources((name, Resource.from_contents(value)) for name,value in schemas.items())
            validator = Draft202012Validator(schemas['interactive-envelope.schema.json'], registry=resources)
            envelope = {'kind':'tinta-interactive','formatVersion':'1.0','engineVersion':'0.1.0-dev.0','abi':'tinta-ir-1','program':{},'baseline':state,'assets':[]}
            add('positive-interactive-envelope', validator.is_valid(envelope))
            for key,value in [('abi','unsupported'),('kind','unsupported'),('baseline',dict(state,sourceSha256='wrong')),('unknown',True)]:
                add('reject-interactive-'+key,not validator.is_valid(dict(envelope,**{key:value})))
        except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
            add('public-input', False, str(exc))
    else:
        result = command(['tsc','--version']); commands.append(result)
        add('typescript-prerequisite', result['exitCode'] == 0, result['stderr'])
    failed = sum(not c['passed'] for c in checks)
    report = {'kind':'contract-checks','checkedAtUTC':datetime.now(timezone.utc).isoformat(),
              'status':'FAIL' if failed else 'PASS',
              'scope':'Type compilation and envelope schemas only; no semantic IR validation or runtime tests.',
              'runtimeTestsExecuted':False, 'localToolsAreNotM0Lock':True,
              'environment':{'python':platform.python_version(),'jsonschema':dependency_version},
              'commands':commands,
              'counts':{'checks':len(checks),'passed':len(checks)-failed,'failed':failed}, 'checks':checks}
    if args.report:
        target = args.report.resolve()
        if target in set(source_files()):
            print('Refusing to overwrite public input:', target, file=sys.stderr)
            return 1
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report,indent=2)+'\n')
    print('Contracts:',report['status'],report['counts'])
    for item in checks:
        if not item['passed']:
            print('FAIL:',item['check'],item['detail'])
    print('No Tinta runtime or language implementation was exercised. Ambient tools do not establish the M0 dependency lock.')
    return 1 if failed else 0

if __name__ == '__main__':
    sys.exit(main())
