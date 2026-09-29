#!/usr/bin/env python3
"""Isolated synthetic-secret regressions. Never contacts a credential provider."""
import json, os, shutil, subprocess, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
# Regression policy is synthetic and never reveals the real owner-supplied terms.
os.environ['KIDS_CONFIDENTIAL_TERMS']='private'+'fixturebrand'
def run(args,cwd):return subprocess.run(args,cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
with tempfile.TemporaryDirectory(prefix='kids-secret-gate-test-') as tmp:
 r=Path(tmp);(r/'scripts').mkdir();(r/'.githooks').mkdir()
 for file in ['scripts/secret-scan.py','.gitleaks.toml','.githooks/pre-commit','.githooks/pre-push','.githooks/commit-msg']:
  shutil.copyfile(ROOT/file,r/file)
 for p in (r/'.githooks').iterdir():p.chmod(0o755)
 (r/'.secret-allowlist.json').write_text('{"entries":[]}')
 assert run(['git','init','-q'],r).returncode==0
 for k,v in [('user.name','Secret Gate Test'),('user.email','test@example.invalid'),('core.hooksPath','.githooks')]:assert run(['git','config',k,v],r).returncode==0
 (r/'ok.txt').write_text('safe content\n');run(['git','add','ok.txt'],r)
 clean=run(['python3','scripts/secret-scan.py','staged'],r);assert clean.returncode==0,clean.stdout+clean.stderr
 assert run(['git','commit','-qm','clean fixture'],r).returncode==0
 # A made-up credential with realistic structure, never usable. Construct it so the test source contains no literal key.
 secret='gh'+'p_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
 (r/'leak.txt').write_text('token='+secret+'\n');run(['git','add','leak.txt'],r)
 (r/'leak.txt').write_text('working copy cleaned; staged index still contains the candidate\n')
 blocked=run(['git','commit','-qm','must fail'],r)
 assert blocked.returncode!=0,'hook accepted staged secret'
 assert secret not in blocked.stdout+blocked.stderr,'hook exposed secret'
 assert 'BLOCKED' in blocked.stdout+blocked.stderr,'hook did not run'
 # Build an isolated historical fixture via Git plumbing; it never leaves this temporary repository.
 tree=run(['git','write-tree'],r).stdout.strip()
 commit=run(['git','commit-tree',tree,'-p','HEAD','-m','synthetic historical fixture'],r).stdout.strip()
 assert commit;assert run(['git','update-ref','refs/heads/history-fixture',commit],r).returncode==0
 history=run(['python3','scripts/secret-scan.py','history'],r)
 assert history.returncode!=0 and secret not in history.stdout+history.stderr
 # An ignored build folder still must be scanned explicitly before publication.
 artifacts=r/'dist';artifacts.mkdir();(artifacts/'bundle.js').write_text('token='+secret)
 artifact=run(['python3','scripts/secret-scan.py','artifacts',str(artifacts)],r)
 assert artifact.returncode!=0 and secret not in artifact.stdout+artifact.stderr
 # Serialized Solana private-key-shaped data and private runtime filenames are blocked too.
 (artifacts/'bundle.js').write_text(json.dumps(list(range(64))))
 assert run(['python3','scripts/secret-scan.py','artifacts',str(artifacts)],r).returncode!=0
 (artifacts/'bundle.js').unlink();(artifacts/'.env').write_text('LOCAL_ONLY=1')
 assert run(['python3','scripts/secret-scan.py','artifacts',str(artifacts)],r).returncode!=0
 # An allowlist for a different value must not conceal this candidate.
 (r/'.secret-allowlist.json').write_text(json.dumps({'entries':[{'rule':'github-pat','path':'leak.txt','sha256':'0'*64,'reason':'different synthetic value'}]}))
 assert run(['python3','scripts/secret-scan.py','staged'],r).returncode!=0
 # Missing tooling fails closed rather than skipping the hook.
 missing=subprocess.run([__import__('sys').executable,'scripts/secret-scan.py','staged'],cwd=r,env={**os.environ,'PATH':''},text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 assert missing.returncode==2 and 'required' in missing.stderr
print('PASS: missing-tool refusal; clean commit; dirty-index blocking; hook redaction; historical leak; build artifact; Solana key; private file; exact exception matching')

# Confidential affiliation regression fixtures are constructed at runtime only.
import hashlib, zipfile
with tempfile.TemporaryDirectory(prefix='kids-confidential-test-') as tmp:
 r=Path(tmp);(r/'scripts').mkdir();(r/'.githooks').mkdir()
 for file in ['scripts/secret-scan.py','.gitleaks.toml','.githooks/pre-commit','.githooks/commit-msg']:
  shutil.copyfile(ROOT/file,r/file)
 for p in (r/'.githooks').iterdir():p.chmod(0o755)
 (r/'.secret-allowlist.json').write_text('{"entries":[]}')
 assert run(['git','init','-q'],r).returncode==0
 for k,v in [('user.name','Confidential Gate Test'),('user.email','test@example.invalid'),('core.hooksPath','.githooks')]:
  assert run(['git','config',k,v],r).returncode==0
 private=os.environ['KIDS_CONFIDENTIAL_TERMS']
 def scan(mode,*paths):
  p=run(['python3','scripts/secret-scan.py',mode,*map(str,paths)],r)
  assert private not in (p.stdout+p.stderr).lower(),'confidential identifier leaked in diagnostics'
  return p
 (r/'vendors.txt').write_text('KIDS Shartcoin Solana Pinata Railway GitHub React Vite\n')
 run(['git','add','vendors.txt'],r)
 assert scan('staged').returncode==0,'legitimate providers were blocked'
 assert run(['git','commit','-qm','clean fixture'],r).returncode==0
 (r/'candidate.txt').write_text(private.upper())
 run(['git','add','candidate.txt'],r)
 (r/'candidate.txt').write_text('working copy clean')
 assert scan('staged').returncode==1,'case-insensitive staged content missed'
 (r/'.secret-allowlist.json').write_text(json.dumps({'entries':[{'rule':'confidential-project-reference','path':'candidate.txt','sha256':hashlib.sha256(private.upper().encode()).hexdigest(),'reason':'must never bypass confidentiality'}]}))
 assert scan('staged').returncode==1,'confidentiality allowlist was accepted'
 run(['git','reset','-q','HEAD'],r)
 (r/(private.upper()+'.txt')).write_text('no prohibited content')
 assert scan('worktree').returncode==1,'confidential filename missed'
 (r/(private.upper()+'.txt')).unlink()
 msg=r/'commit-message';msg.write_text('Old affiliation: '+private.upper())
 assert scan('message',msg).returncode==1
 p=run(['git','commit','--allow-empty','-qm','Old affiliation: '+private.upper()],r)
 assert p.returncode!=0 and private not in (p.stdout+p.stderr).lower(),'commit message hook failed'
 msg.unlink()
 artifacts=r/'dist';artifacts.mkdir()
 with zipfile.ZipFile(artifacts/'payload.zip','w') as archive:archive.writestr('notes.txt',private.upper())
 assert scan('artifacts',artifacts).returncode==1,'archived content missed'
 with zipfile.ZipFile(artifacts/'payload.zip','w') as archive:archive.writestr(private.upper()+'.txt','safe body')
 assert scan('artifacts',artifacts).returncode==1,'archived confidential filename missed'
 with zipfile.ZipFile(artifacts/'payload.zip','w') as archive:archive.writestr('.env','LOCAL_ONLY=1')
 assert scan('artifacts',artifacts).returncode==1,'archived private filename missed'

 tree=run(['git','rev-parse','HEAD^{tree}'],r).stdout.strip()
 commit=run(['git','commit-tree',tree,'-p','HEAD','-m','Old affiliation: '+private.upper()],r).stdout.strip()
 assert run(['git','update-ref','refs/heads/metadata-fixture',commit],r).returncode==0
 assert scan('history').returncode==1,'historical commit metadata missed'
 run(['git','update-ref','-d','refs/heads/metadata-fixture'],r)
 assert run(['git','tag','-a','fixture-tag','-m',private.upper()],r).returncode==0
 assert scan('history').returncode==1,'annotated tag metadata missed'
 run(['git','tag','-d','fixture-tag'],r)
 token='gh'+'p_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
 assert run(['git','tag','-a','credential-fixture','-m',token],r).returncode==0
 p=scan('history');assert p.returncode==1 and token not in p.stdout+p.stderr,'tag credential missed or printed'
 run(['git','tag','-d','credential-fixture'],r)

 assert run(['git','update-ref','refs/heads/'+private.upper(),'HEAD'],r).returncode==0
 assert scan('history').returncode==1,'ref name missed'
 run(['git','update-ref','-d','refs/heads/'+private.upper()],r)
 (r/(private.upper()+'.txt')).write_text('historical filename')
 run(['git','add',private.upper()+'.txt'],r)
 tree=run(['git','write-tree'],r).stdout.strip()
 commit=run(['git','commit-tree',tree,'-p','HEAD','-m','filename fixture'],r).stdout.strip()
 run(['git','update-ref','refs/heads/filename-fixture',commit],r)
 assert scan('history').returncode==1,'historical filename missed'
print('PASS: confidentiality staged content, filenames, commit hook, history, tags, refs, archives, diagnostic redaction, no exceptions; legitimate vendors allowed')

# Missing policy fails closed even when the scanner is installed.
missing_policy=subprocess.run(['python3',str(ROOT/'scripts/secret-scan.py'),'policy'],env={**os.environ,'KIDS_CONFIDENTIAL_TERMS':''},text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert missing_policy.returncode==2 and 'policy is required' in missing_policy.stderr
print('PASS: missing private policy fails closed; test policy is synthetic')
