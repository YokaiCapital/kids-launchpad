"""Check an export tree before publication. Reports paths, never matched secrets."""
from pathlib import Path
import re,sys,zipfile,io
root=Path(sys.argv[1] if len(sys.argv)>1 else Path(__file__).resolve().parents[1])
# Supply project-specific private exclusions locally; never embed identities in source.
import os
names=[term.strip().lower() for term in os.environ.get('PUBLICATION_DENY_TERMS','').split(',') if term.strip()]
patterns=[rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY',rb'gh[pousr]_[A-Za-z0-9]{30,}',rb'github_pat_[A-Za-z0-9_]{30,}',rb'AKIA[A-Z0-9]{16}',bytes([47,85,115,101,114,115,47])+rb'[^/\s]+/']
excluded={'node_modules','.runtime','.stage','.git','dist','target','build','__pycache__'}
failures=[];count=0
def check(label,data):
 low=data.lower()
 if any(n.encode() in low for n in names):failures.append((label,'excluded identifier'))
 if any(re.search(p,data) for p in patterns):failures.append((label,'credential or personal path pattern'))
for f in root.rglob('*'):
 rel=f.relative_to(root)
 if any(p in excluded for p in rel.parts):continue
 if f.is_symlink():failures.append((str(rel),'symlink'));continue
 if not f.is_file():continue
 count+=1
 if any(n in str(rel).lower() for n in names):failures.append((str(rel),'excluded filename'))
 if f.name.startswith('.env') and f.name!='.env.example':failures.append((str(rel),'environment file'))
 if f.suffix in {'.sqlite','.db','.pem','.key'} or 'keypair' in f.name:failures.append((str(rel),'private runtime file'))
 data=f.read_bytes();check(str(rel),data)
 if f.suffix=='.zip':
  with zipfile.ZipFile(io.BytesIO(data)) as z:
   for name in z.namelist():check(str(rel)+'!'+name,z.read(name))
for label,reason in failures:print(reason+': '+label)
print(f'Checked {count} export files; {len(failures)} findings. Pattern checks are not a guarantee of absence of all secrets.')
sys.exit(bool(failures))
