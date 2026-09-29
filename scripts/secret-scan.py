#!/usr/bin/env python3
"""Fail-closed secret gate. Findings contain locations/rules, never matched values."""
import argparse, hashlib, io, json, os, re, shutil, stat, subprocess, sys, tarfile, tempfile, zipfile
from pathlib import Path

PIN = '8.30.1'
ROOT = Path(__file__).resolve().parents[1]

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])

# The real policy is private, never encoded or embedded in published source.
PRIVATE_NAMES = ()
def load_private_policy():
    raw = os.environ.get('KIDS_CONFIDENTIAL_TERMS')
    if raw is None:
        location = Path(os.fsdecode(git('rev-parse', '--git-path', 'info/kids-confidential-terms')).strip())
        location = location if location.is_absolute() else ROOT / location
        raw = location.read_text() if location.is_file() else ''
    terms = tuple(dict.fromkeys(term.strip().lower().encode() for term in raw.splitlines() if term.strip()))
    if not terms or any(len(term) < 3 for term in terms):
        raise RuntimeError('Private confidentiality policy is required; obtain it from the repository owner. No bypass.')
    return terms
def confidential(data):
    return any(name in data.lower() for name in PRIVATE_NAMES)
def safe_path(path):
    for name in PRIVATE_NAMES:
        path = re.sub(re.escape(name.decode()), '[confidential]', path, flags=re.I)
    return path

def forbidden(path):
    p = Path(path)
    return ((p.name.startswith('.env') and p.name != '.env.example') or
            p.suffix.lower() in {'.pem', '.key', '.p12', '.pfx', '.sqlite', '.db'} or
            p.name.endswith(('-keypair.json', '-secret.json')) or
            p.name in {'id_rsa', 'id_ed25519', 'credentials.json'})

def archive_names(data, label, findings, depth=0, budget=None):
    # Inspect member paths without extracting files onto disk; fail closed on limits.
    budget = [128 * 1024 * 1024] if budget is None else budget
    suffix = label.lower()
    is_zip = data.startswith((b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08'))
    is_tar = suffix.endswith(('.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz'))
    if not (is_zip or is_tar): return
    if depth >= 3: raise RuntimeError('Archive nesting exceeds inspection limit')
    if is_zip:
        archive = zipfile.ZipFile(io.BytesIO(data))
        members = [(x.filename, x.file_size, stat.S_ISLNK(x.external_attr >> 16), x) for x in archive.infolist()]
    else:
        archive = tarfile.open(fileobj=io.BytesIO(data), mode='r:*')
        members = [(x.name, x.size, x.issym() or x.islnk(), x) for x in archive.getmembers()]
    with archive:
        for name, size, link, member in members:
            member_path = label + '!' + name
            if confidential(os.fsencode(name)): findings.append({'rule':'confidential-archive-filename','path':member_path,'line':0})
            if forbidden(name): findings.append({'rule':'private-archive-file','path':member_path,'line':0})
            if link: findings.append({'rule':'archive-link-review-required','path':member_path,'line':0}); continue
            if size > budget[0]: raise RuntimeError('Archive expanded size exceeds inspection limit')
            budget[0] -= size
            if is_zip: contents = archive.read(member)
            else:
                stream = archive.extractfile(member) if member.isfile() else None
                contents = stream.read() if stream else b''
            archive_names(contents, member_path, findings, depth + 1, budget)

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('mode', choices=['staged', 'worktree', 'history', 'artifacts', 'message', 'policy'])
    ap.add_argument('paths', nargs='*')
    ap.add_argument('--report', type=Path)
    args = ap.parse_args()
    binary = shutil.which('gitleaks')
    if not binary:
        raise RuntimeError('gitleaks 8.30.1 is required; install it before committing. No bypass.')
    version = subprocess.check_output([binary, 'version'], text=True).strip().lstrip('v')
    if version != PIN:
        raise RuntimeError('gitleaks must be pinned to ' + PIN)
    global PRIVATE_NAMES
    PRIVATE_NAMES = load_private_policy()
    if args.mode == 'policy':
        print('Private confidentiality policy loaded; values are never displayed.')
        return 0
    base_config = ROOT / '.gitleaks.toml'
    allow = json.loads((ROOT / '.secret-allowlist.json').read_text())
    exceptions = {(e['rule'], e['path'], e['sha256']) for e in allow['entries'] if e.get('reason')}
    findings, reviewed, scanned = [], 0, 0
    # All raw scanner reports live in a mode-0700 temporary directory, then are deleted.
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='kids-secret-scan-') as tmp:
        temp = Path(tmp)
        config = temp / 'gitleaks.toml'
        expression = '(?i)(?:' + '|'.join(re.escape(term.decode()) for term in PRIVATE_NAMES) + ')'
        config.write_text(base_config.read_text() + '\n[[rules]]\nid = "confidential-project-reference"\ndescription = "Confidential first-party affiliation"\nregex = ' + json.dumps(expression) + '\n')
        sources = []
        if args.mode in {'staged', 'worktree'}:
            snapshot = temp / 'tree'; snapshot.mkdir()
            if args.mode == 'staged':
                if git('ls-files', '--unmerged'):
                    raise RuntimeError('Resolve unmerged index entries before scanning')
                git('checkout-index', '--all', '--prefix=' + str(snapshot) + '/')
            else:
                for raw in set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0')):
                    if not raw: continue
                    rel = Path(os.fsdecode(raw)); src = ROOT / rel; dst = snapshot / rel
                    if src.is_symlink():
                        findings.append({'rule':'symlink-review-required','path':str(rel),'line':0}); continue
                    if not src.is_file(): continue
                    dst.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src,dst)
            sources = [('dir', snapshot)]
        elif args.mode == 'history':
            if len(args.paths) > 1: raise RuntimeError('At most one repository path is allowed')
            repository = Path(args.paths[0]).resolve() if args.paths else ROOT
            metadata = subprocess.check_output(['git','-C',str(repository),'log','--all','--format=%B%n%an <%ae>%n%cn <%ce>'])
            metadata += subprocess.check_output(['git','-C',str(repository),'for-each-ref','--format=%(refname)%0a%(contents)%0a%(taggername) %(taggeremail)'])
            snapshot = temp / 'metadata'; snapshot.mkdir()
            (snapshot / 'git-metadata.txt').write_bytes(metadata)
            sources = [('git', repository), ('dir', snapshot)]
        elif args.mode == 'message':
            if len(args.paths) != 1: raise RuntimeError('Exactly one commit message path required')
            snapshot = temp / 'message'; snapshot.mkdir()
            shutil.copyfile(args.paths[0], snapshot / 'message.txt')
            sources = [('dir', snapshot)]
        else:
            if not args.paths: raise RuntimeError('Explicit build/deployment artifact paths required')
            sources = [('dir', Path(p).resolve()) for p in args.paths]
        for index, (kind, source) in enumerate(sources):
            if not source.exists(): raise RuntimeError('Scan target is missing')
            report = temp / ('raw-' + str(index) + '.json')
            cmd = [binary, kind, str(source), '--config', str(config), '--no-banner', '--log-level', 'error',
                   '--ignore-gitleaks-allow', '--gitleaks-ignore-path', str(temp/'no-ignores'),
                   '--max-archive-depth', '3', '--max-decode-depth', '5', '--report-format', 'json', '--report-path', str(report)]
            if kind == 'git': cmd += ['--log-opts=--all --full-history']
            # Do not echo scanner output: even unexpected tool errors must not expose a match.
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode not in (0,1) or not report.exists():
                raise RuntimeError('Secret scanner failed; commit/release blocked (no raw output printed)')
            for row in json.loads(report.read_text()):
                path = row['File']
                if kind == 'dir':
                    try: path = str(Path(path).relative_to(source))
                    except ValueError: pass
                fingerprint = hashlib.sha256(row['Secret'].encode()).hexdigest()
                if row['RuleID'] != 'confidential-project-reference' and (row['RuleID'],path,fingerprint) in exceptions:
                    reviewed += 1; continue
                findings.append({'rule':row['RuleID'],'path':path,'line':row['StartLine'],
                                 'commit':row.get('Commit',''),'fingerprint':fingerprint})
            if kind == 'dir':
                for p in source.rglob('*'):
                    if p.is_symlink():
                        findings.append({'rule':'symlink-review-required','path':str(p.relative_to(source)),'line':0});continue
                    if not p.is_file(): continue
                    scanned += 1; rel = str(p.relative_to(source))
                    if confidential(os.fsencode(rel)): findings.append({'rule':'confidential-filename','path':safe_path(rel),'line':0})
                    if forbidden(rel): findings.append({'rule':'private-file','path':rel,'line':0})
                    archive_names(p.read_bytes(), rel, findings)
            else:
                # Deleted private files are still an exposure; inspect names across all reachable history.
                for raw in set(subprocess.check_output(['git','-C',str(source),'log','--all','--format=','--name-only','-z']).split(b'\0')):
                    rel = os.fsdecode(raw).strip('\n')
                    if rel and confidential(os.fsencode(rel)): findings.append({'rule':'historical-confidential-filename','path':safe_path(rel),'line':0})
                    if rel and forbidden(rel): findings.append({'rule':'historical-private-file','path':rel,'line':0})
                # Commit/tag messages and ref names are public metadata too.
                metadata = subprocess.check_output(['git','-C',str(source),'log','--all','--format=%B'])
                metadata += subprocess.check_output(['git','-C',str(source),'for-each-ref','--format=%(refname)%0a%(contents)'])
                if confidential(metadata): findings.append({'rule':'confidential-git-metadata','path':'[git metadata]','line':0})
    for finding in findings: finding['path'] = safe_path(finding['path'])
    output={'mode':args.mode,'scanner':'gitleaks '+PIN,'files':scanned,'reviewed_exact_exceptions':reviewed,'findings':findings}
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(output,indent=2)+'\n')
    for f in findings:
        print('BLOCKED: '+f['rule']+' '+f['path']+':'+str(f['line']))
    print(f"Secret gate: {len(findings)} unresolved findings; {reviewed} exact reviewed exceptions; mode={args.mode}")
    return 1 if findings else 0

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as e:
        # Only controlled messages are displayed; arbitrary dependency/path data is not echoed.
        if isinstance(e,RuntimeError): print('BLOCKED: '+str(e),file=sys.stderr)
        else: print('BLOCKED: secret scan could not complete ('+type(e).__name__+')',file=sys.stderr)
        sys.exit(2)
