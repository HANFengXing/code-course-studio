#!/usr/bin/env python3
"""Local evidence indexing and deterministic, offline course rendering (stdlib only)."""
from __future__ import annotations

import argparse
import ast
import datetime as dt
import fnmatch
import hashlib
import html
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sys

VERSION = '0.1.0'
ASSETS = Path(__file__).resolve().parent.parent / 'assets'
EXTENSIONS = {'.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.cs', '.java', '.rs', '.go', '.m', '.v', '.sv', '.vhd', '.vhdl', '.proto', '.md', '.rst', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.xml', '.cmake'}
SKIP_DIRS = {'.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vs', 'dist', 'build', 'target'}
MAX_COURSE_BYTES = 16 * 1024 * 1024

def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read_json(path):
    path = Path(path)
    if path.stat().st_size > MAX_COURSE_BYTES:
        raise ValueError(f'JSON exceeds {MAX_COURSE_BYTES} bytes: {path.name}')
    return json.loads(path.read_text(encoding='utf-8-sig'))

def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')

def source_file(root, relative):
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError('source path must be a nonempty relative string')
    name = relative.replace('\\', '/')
    parts = PurePosixPath(name).parts
    if name.startswith('/') or ':' in name or '..' in parts:
        raise ValueError(f'unsafe source path: {relative}')
    target = (root / name).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        raise ValueError(f'source path escapes root: {relative}') from None
    if not target.is_file():
        raise ValueError(f'source file missing: {relative}')
    return target

def read_source(path, max_bytes=8 * 1024 * 1024):
    if path.stat().st_size > max_bytes:
        raise ValueError(f'file exceeds {max_bytes} bytes: {path.name}')
    raw = path.read_bytes()
    if b'\0' in raw:
        raise ValueError(f'binary/NUL file: {path.name}')
    try:
        text = raw.decode('utf-8-sig')
        encoding = 'utf-8'
    except UnicodeDecodeError:
        try:
            text = raw.decode('gb18030')
            encoding = 'gb18030'
        except UnicodeDecodeError:
            raise ValueError(f'unsupported encoding: {path.name}') from None
    lines = text.split('\n')
    if lines and lines[-1] == '':
        lines.pop()
    return raw, [line.removesuffix('\r') for line in lines], encoding

def language(path):
    ext = Path(path).suffix.lower()
    return {'.h':'cpp','.hpp':'cpp','.cc':'cpp','.cxx':'cpp','.py':'python','.js':'javascript','.ts':'typescript','.md':'markdown','.sv':'systemverilog'}.get(ext, ext.lstrip('.') or 'text')

def symbols_for(path, lines):
    """Python AST definitions, lexical candidates elsewhere: never a call graph."""
    results = []
    warnings = []
    if path.suffix == '.py':
        try:
            tree = ast.parse('\n'.join(lines))
            results = [{'name': n.name, 'line': n.lineno, 'end_line': n.end_lineno, 'kind': type(n).__name__, 'confidence': 'python-ast-definition'} for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        except SyntaxError as exc:
            warnings.append(f'Python AST unavailable at line {exc.lineno}; only file index retained')
    elif path.suffix.lower() in {'.c','.h','.cpp','.cc','.cxx','.hpp','.hxx','.js','.ts','.mjs','.cjs','.cs','.java','.go','.rs','.v','.sv'}:
        pattern = re.compile(r'^\s*(?:(?:export|static|inline|virtual|constexpr|public|private|protected|async)\s+)*(?:class|struct|enum|namespace|function|module|interface|fn)\s+([A-Za-z_$][\w$:]*)|^\s*(?:[\w:*&<>\[\],]+\s+)+([A-Za-z_$~][\w$:]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)')
        for number, line in enumerate(lines, 1):
            match = pattern.search(line)
            if match:
                name = match.group(1) or match.group(2)
                if name not in {'if','for','while','switch','return','catch'}:
                    results.append({'name': name, 'line': number, 'kind': 'lexical-candidate', 'confidence': 'unverified'})
    if len(results) > 250:
        warnings.append(f'symbol candidates truncated: {len(results)} → 250')
    return results[:250], warnings

def cmd_index(args):
    root = Path(args.source).resolve()
    out = Path(args.out).resolve()
    if not root.is_dir():
        raise ValueError('source must be a directory')
    if out == root:
        raise ValueError('index output must not equal the source root; use a separate subdirectory')
    output_inside_source = root in out.parents
    files, skipped, modules = [], [], {}
    seen_dirs, stack = set(), [root]
    total = 0
    skip_count = 0
    def skip(path, reason):
        nonlocal skip_count
        skip_count += 1
        if len(skipped) < 5000:
            skipped.append({'path': path, 'reason': reason})
    while stack:
        directory = stack.pop()
        real = directory.resolve()
        if real in seen_dirs:
            continue
        seen_dirs.add(real)
        try:
            entries = sorted(directory.iterdir(), key=lambda p: p.name.casefold())
        except OSError as exc:
            skip(str(directory.relative_to(root)), f'unreadable directory: {exc.__class__.__name__}')
            continue
        for path in entries:
            rel = path.relative_to(root).as_posix()
            try:
                resolved = path.resolve()
                resolved.relative_to(root)
                if path.is_symlink():
                    skip(rel, 'symbolic link not followed')
                    continue
                if output_inside_source and (resolved == out or out in resolved.parents):
                    skip(rel, 'output directory')
                    continue
                if path.is_dir():
                    if path.name in SKIP_DIRS or any(fnmatch.fnmatch(rel, p) for p in args.exclude):
                        skip(rel, 'excluded directory (subtree not counted)')
                    else:
                        stack.append(path)
                    continue
                if not path.is_file():
                    continue
                if any(fnmatch.fnmatch(rel, p) for p in args.exclude):
                    skip(rel, 'user exclusion')
                    continue
                if path.suffix.lower() not in EXTENSIONS and path.name not in {'CMakeLists.txt', 'Makefile'}:
                    skip(rel, 'unsupported extension')
                    continue
                size = path.stat().st_size
                if len(files) >= args.max_files or total + size > args.max_total_bytes:
                    skip(rel, 'scan budget exceeded')
                    continue
                raw, lines, enc = read_source(path, args.max_file_bytes)
                syms, warnings = symbols_for(path, lines)
                module = '/'.join(path.relative_to(root).parts[:min(2, len(path.relative_to(root).parts)-1)]) or '.'
                files.append({'path': rel, 'module': module, 'bytes': len(raw), 'lines': len(lines), 'sha256': digest(raw), 'encoding': enc, 'language': language(path), 'symbols': syms, 'warnings': warnings})
                total += len(raw)
                item = modules.setdefault(module, {'path': module, 'files': 0, 'lines': 0, 'bytes': 0})
                item['files'] += 1
                item['lines'] += len(lines)
                item['bytes'] += len(raw)
            except (OSError, ValueError) as exc:
                skip(rel, str(exc))
    files.sort(key=lambda f: f['path'])
    fingerprint = digest('\n'.join(f"{f['path']}:{f['sha256']}" for f in files).encode())
    index = {'schema_version': 1, 'tool_version': VERSION, 'source_label': root.name, 'generated_at': utc_now(), 'fingerprint': fingerprint, 'analysis_kind': 'file inventory + Python AST definitions / unverified lexical symbol candidates; no call graph', 'summary': {'files': len(files), 'lines': sum(f['lines'] for f in files), 'bytes': total, 'skipped_entries': skip_count, 'skipped_list_truncated': skip_count > len(skipped)}, 'modules': sorted(modules.values(), key=lambda m: (-m['lines'], m['path'])), 'files': files, 'skipped': skipped}
    write_json(out / 'index.json', index)
    write_json(out / 'coverage.json', {k: index[k] for k in ('source_label','fingerprint','analysis_kind','summary','modules','skipped')})
    print(json.dumps({'index': str(out / 'index.json'), **index['summary']}, ensure_ascii=False))

def cmd_search(args):
    root = Path(args.source).resolve()
    index = read_json(args.index)
    query = args.text.casefold()
    results = []
    spent = 0
    for item in index['files']:
        if args.module and not (item['module'] == args.module or item['path'].startswith(args.module.rstrip('/') + '/')):
            continue
        path = source_file(root, item['path'])
        raw, lines, _ = read_source(path, args.max_file_bytes)
        if digest(raw) != item['sha256']:
            raise ValueError(f"index stale for {item['path']}; rerun index")
        for i, line in enumerate(lines):
            if query not in line.casefold():
                continue
            start, end = max(0, i-args.context), min(len(lines), i+args.context+1)
            excerpt = '\n'.join(f'{n+1}: {lines[n]}' for n in range(start, end))
            if spent + len(excerpt) > args.max_chars or len(results) >= args.limit:
                print(json.dumps({'matches': results, 'truncated': True}, ensure_ascii=False, indent=2))
                return
            results.append({'path': item['path'], 'start_line': start+1, 'end_line': end, 'sha256': item['sha256'], 'excerpt': excerpt})
            spent += len(excerpt)
    print(json.dumps({'matches': results, 'truncated': False}, ensure_ascii=False, indent=2))

def cmd_brief(args):
    index = read_json(args.index)
    rows = [item for item in index['files'] if not args.module or item['module'] == args.module or item['path'].startswith(args.module.rstrip('/') + '/')]
    parts = [f"# 模块调查包：{args.module or index['source_label']}", f"索引快照：{index['fingerprint']}", '这只是调查线索。C/C++ 名称是词法候选，未证明调用关系。请用 search/excerpt 查找原文，先选一个端到端场景，再解释业务、代码、设计与实现。', f"匹配文件 {len(rows)}；全库跳过条目 {index['summary']['skipped_entries']}。", '']
    if len('\n'.join(parts)) + 128 > args.max_chars:
        raise ValueError('max_chars is too small for the brief header and coverage note; use at least 512')
    omitted = 0
    for item in rows:
        chunk = f"\n## {item['path']} ({item['lines']} 行)\nSHA256 {item['sha256']}\n" + '\n'.join(f"- L{s['line']} {s['name']} [{s['confidence']}]" for s in item['symbols'])
        if len('\n'.join(parts)) + len(chunk) + 129 > args.max_chars:
            omitted += 1
        else:
            parts.append(chunk)
    parts.append(f'\n受调查包大小限制，未展开文件数：{omitted}。完整清单保留在 index.json。')
    output = '\n'.join(parts)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(output, encoding='utf-8')
        print(args.out)
    else:
        print(output)

def resolve_evidence(root, refs, max_file_bytes=8 * 1024 * 1024):
    errors, evidence, cache = [], [], {}
    ids = set()
    if not isinstance(refs, list):
        return [], ['evidence must be an array']
    for i, ref in enumerate(refs):
        prefix = f'evidence[{i}]'
        try:
            if not isinstance(ref, dict):
                raise ValueError('must be an object')
            rid = ref.get('id')
            if not isinstance(rid, str) or not rid or rid in ids:
                raise ValueError('id missing or duplicated')
            ids.add(rid)
            path = source_file(root, ref.get('path'))
            if path not in cache:
                cache[path] = read_source(path, max_file_bytes)
            raw, lines, enc = cache[path]
            start, end = ref.get('start_line'), ref.get('end_line')
            if type(start) is not int or type(end) is not int or start < 1 or end < start or end > len(lines) or end-start > 199:
                raise ValueError(f'invalid line range {start}..{end}; actual lines={len(lines)}, maximum excerpt=200 lines')
            sha = digest(raw)
            expected = ref.get('expected_sha256')
            if expected and expected != sha:
                raise ValueError('source changed: SHA256 differs from expected_sha256')
            evidence.append({'id': rid, 'path': path.relative_to(root).as_posix(), 'start_line': start, 'end_line': end, 'expected_sha256': sha, 'sha256': sha, 'encoding': enc, 'language': language(path), 'lines': [{'number': n, 'text': lines[n-1]} for n in range(start,end+1)]})
        except (ValueError, OSError, TypeError) as exc:
            errors.append(f'{prefix}: {exc}')
    return evidence, errors

def validate_course(course, root, max_file_bytes=8 * 1024 * 1024):
    errors, warnings = [], []
    if not isinstance(course, dict):
        return None, {'passed': False, 'errors': ['course must be an object'], 'warnings': []}
    cooked = json.loads(json.dumps(course, ensure_ascii=False))
    def finite_js_number(value):
        if type(value) is int:
            return abs(value) <= 9007199254740991
        return type(value) is float and math.isfinite(value)
    def require_text(obj, keys, prefix):
        for key in keys:
            if not isinstance(obj.get(key), str) or not obj[key].strip():
                errors.append(f'{prefix}.{key}: nonempty text required')
    if cooked.get('schema_version') != 1:
        errors.append('schema_version must equal 1')
    require_text(cooked, ('title','subtitle','audience'), 'course')
    overview = cooked.get('overview', {})
    if not isinstance(overview, dict):
        errors.append('overview must be an object')
        overview = {}
    require_text(overview, ('problem','inputs','outputs','scope'), 'overview')
    for field in ('unknowns',):
        if not isinstance(overview.get(field), list) or not all(isinstance(x,str) for x in overview.get(field, [])):
            errors.append('overview.unknowns must be an array of text')
    evidence, ref_errors = resolve_evidence(root, cooked.get('evidence', []), max_file_bytes)
    errors.extend(ref_errors)
    cooked['evidence'] = evidence
    known_refs = {e['id'] for e in evidence}
    if not evidence:
        errors.append('at least one valid source reference is required')
    used_refs = set()
    def check_refs(obj, prefix):
        refs = obj.get('evidence_ids')
        if not isinstance(refs, list) or not refs:
            errors.append(f'{prefix}: evidence_ids required')
            return
        for rid in refs:
            if not isinstance(rid, str) or rid not in known_refs:
                errors.append(f'{prefix}: unknown evidence id {rid!r}')
            else:
                used_refs.add(rid)
    chapters = cooked.get('chapters')
    if not isinstance(chapters, list) or not chapters or len(chapters)>100:
        errors.append('chapters must have 1..100 entries (split larger courses into volumes)')
        chapters = []
    chapter_ids = set()
    for ci, chapter in enumerate(chapters):
        prefix = f'chapters[{ci}]'
        if not isinstance(chapter, dict):
            errors.append(prefix + ': object required')
            continue
        require_text(chapter, ('id','title','question','summary'), prefix)
        cid = chapter.get('id')
        if not isinstance(cid, str) or not re.fullmatch(r'[a-zA-Z0-9_-]+', cid) or cid in chapter_ids:
            errors.append(prefix + ': id must be unique and contain only letters/numbers/-/_')
        else:
            chapter_ids.add(cid)
        goals = chapter.get('learning_goals')
        if not isinstance(goals,list) or not goals or not all(isinstance(x,str) and x.strip() for x in goals):
            errors.append(prefix + ': learning_goals required')
        node_sets = {}
        for flow_key in ('business_flow','code_flow'):
            nodes = chapter.get(flow_key)
            node_sets[flow_key] = set()
            if not isinstance(nodes,list) or not 1 <= len(nodes) <= 24:
                errors.append(prefix + '.' + flow_key + ': 1..24 nodes required; split dense diagrams')
                continue
            for ni,node in enumerate(nodes):
                np = f'{prefix}.{flow_key}[{ni}]'
                if not isinstance(node,dict):
                    errors.append(np + ': object required')
                    continue
                require_text(node, ('id','label','description','inputs','outputs'), np)
                nid = node.get('id')
                if not isinstance(nid,str) or nid in node_sets[flow_key]:
                    errors.append(np + ': unique text id required')
                else:
                    node_sets[flow_key].add(nid)
                check_refs(node,np)
        for edge_key, flow_key in (('business_edges','business_flow'),('code_edges','code_flow')):
            edges = chapter.get(edge_key,[])
            if not isinstance(edges,list):
                errors.append(prefix + '.' + edge_key + ': array required')
                continue
            for ei,edge in enumerate(edges):
                ep = f'{prefix}.{edge_key}[{ei}]'
                if not isinstance(edge,dict):
                    errors.append(ep + ': object required')
                    continue
                require_text(edge, ('from','to','label','kind'), ep)
                if any(not isinstance(edge.get(k),str) or edge[k] not in node_sets[flow_key] for k in ('from','to')):
                    errors.append(ep + ': edge endpoint does not refer to a node')
                if edge.get('kind') not in ('call','message','branch','data','return','sequence'):
                    errors.append(ep + ': invalid relationship kind')
                check_refs(edge,ep)
        for key, fields in (('design_decisions', ('title','decision','why','tradeoff')), ('implementation', ('title','explanation'))):
            items = chapter.get(key)
            if not isinstance(items,list) or not items:
                errors.append(prefix + '.' + key + ': nonempty list required')
                continue
            for ni,item in enumerate(items):
                np = f'{prefix}.{key}[{ni}]'
                if not isinstance(item,dict):
                    errors.append(np + ': object required')
                    continue
                require_text(item, fields, np)
                check_refs(item,np)
                if key == 'design_decisions' and item.get('status') not in ('documented','inferred'):
                    errors.append(np + ': design status must be documented or inferred')
        animation = chapter.get('animation', {})
        if not isinstance(animation,dict):
            errors.append(prefix + '.animation: object required')
            continue
        require_text(animation, ('description',), prefix + '.animation')
        if 'point_axes' in animation:
            if not isinstance(animation['point_axes'],dict):
                errors.append(prefix + ': point_axes must be an object')
            else:
                require_text(animation['point_axes'], ('x_label','y_label'), prefix + '.point_axes')
        mode = animation.get('mode')
        if mode not in ('illustrative','runtime_trace'):
            errors.append(prefix + ': animation.mode must distinguish illustrative or runtime_trace')
        if mode == 'runtime_trace':
            try:
                trace_path = source_file(root, animation.get('trace_path'))
                trace_raw = trace_path.read_bytes()
                trace = read_json(trace_path)
                if not isinstance(trace,dict):
                    raise ValueError('trace must be an object')
                if not isinstance(trace.get('description'),str) or not trace['description'].strip():
                    raise ValueError('trace description must be nonempty text')
                trace_sha = digest(trace_raw)
                if animation.get('expected_trace_sha256') and animation['expected_trace_sha256'] != trace_sha:
                    raise ValueError('trace changed: SHA256 mismatch')
                animation['steps'] = trace.get('steps')
                animation['trace_sha256'] = trace_sha
                animation['expected_trace_sha256'] = trace_sha
                warnings.append(prefix + ': external trace supplied; not reproduced or authenticated by this tool')
            except (ValueError,OSError,TypeError) as exc:
                errors.append(prefix + f': trace invalid: {exc}')
        steps = animation.get('steps')
        if not isinstance(steps,list) or not 1 <= len(steps) <= 10000:
            errors.append(prefix + ': animation requires 1..10000 steps')
            continue
        for si,step in enumerate(steps):
            sp = f'{prefix}.steps[{si}]'
            if not isinstance(step,dict):
                errors.append(sp + ': object required')
                continue
            require_text(step, ('title','explanation'), sp)
            check_refs(step,sp)
            for field, flow_key in (('business_node_id','business_flow'),('code_node_id','code_flow')):
                if not isinstance(step.get(field),str) or step[field] not in node_sets[flow_key]:
                    errors.append(sp + f': {field} does not refer to a node')
            state = step.get('state')
            if not isinstance(state,dict) or not state:
                errors.append(sp + ': nonempty state object required')
            elif any(not isinstance(k,str) or not isinstance(v,(str,int,float,bool,type(None))) or type(v) in (int,float) and not finite_js_number(v) for k,v in state.items()):
                errors.append(sp + ': state values must be finite scalar values')
            points = step.get('points',[])
            if not isinstance(points,list) or len(points)>2000:
                errors.append(sp + ': at most 2000 illustrative points allowed')
            else:
                for point in points:
                    if not isinstance(point,dict) or any(not finite_js_number(point.get(axis)) for axis in ('x','y')) or not isinstance(point.get('label'),str) or ('group' in point and not isinstance(point['group'],str)):
                        errors.append(sp + ': point requires finite x/y and text label')
                        break
        quizzes = chapter.get('quiz')
        if not isinstance(quizzes,list) or not quizzes:
            errors.append(prefix + ': at least one transfer quiz required')
        else:
            for qi,quiz in enumerate(quizzes):
                qp = f'{prefix}.quiz[{qi}]'
                if not isinstance(quiz,dict):
                    errors.append(qp + ': object required')
                    continue
                require_text(quiz, ('question','explanation'), qp)
                options = quiz.get('options')
                answer = quiz.get('answer_index')
                if not isinstance(options,list) or len(options)<2 or not all(isinstance(x,str) and x for x in options) or type(answer) is not int or not 0 <= answer < len(options):
                    errors.append(qp + ': valid options and answer_index required')
                check_refs(quiz,qp)
    routes = cooked.get('study_paths',[])
    if not isinstance(routes,list):
        errors.append('study_paths must be an array')
        routes = []
    for route in routes:
        if not isinstance(route,dict) or not isinstance(route.get('title'),str) or not isinstance(route.get('chapter_ids'),list) or any(not isinstance(cid,str) or cid not in chapter_ids for cid in route.get('chapter_ids',[])):
            errors.append('study_paths contains invalid chapter references')
    terms = cooked.get('glossary',[])
    if not isinstance(terms,list):
        errors.append('glossary must be an array')
        terms = []
    for term in terms:
        if not isinstance(term,dict) or not isinstance(term.get('term'),str) or not isinstance(term.get('meaning'),str):
            errors.append('glossary terms require term and meaning text')
    unused = known_refs-used_refs
    if unused:
        warnings.append('unused source references: ' + ', '.join(sorted(unused)))
    report = {'passed': not errors, 'errors': errors, 'warnings': warnings, 'chapters': len(chapters), 'evidence': len(evidence), 'checked': ['four teaching sections','exact source line ranges','source/trace hash pins when supplied','reference and node links','animation provenance','quiz shape'], 'not_checked': ['semantic correctness of explanations','completeness of codebase coverage','truth of inferred design intent','actual program execution','pedagogical effectiveness']}
    cooked['build'] = {'source_label': root.name, 'source_fingerprint': digest('\n'.join(sorted(f"{e['path']}:{e['sha256']}" for e in evidence)).encode()), 'evidence_count': len(evidence), 'chapter_count': len(chapters), 'validation': 'source references and structure checked; explanations require review', 'generated_at': utc_now()}
    return cooked, report

def cmd_excerpt(args):
    refs, errors = resolve_evidence(Path(args.source).resolve(), [{'id':'excerpt','path':args.path,'start_line':args.start,'end_line':args.end}], args.max_file_bytes)
    if errors:
        raise ValueError('; '.join(errors))
    print(json.dumps(refs[0], ensure_ascii=False, indent=2))

def cmd_validate(args):
    cooked, report = validate_course(read_json(args.course), Path(args.source).resolve(), args.max_file_bytes)
    if args.report:
        write_json(args.report,report)
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report['passed'] else 1

def cmd_build(args):
    root = Path(args.source).resolve()
    cooked, report = validate_course(read_json(args.course),root,args.max_file_bytes)
    out = Path(args.out).resolve()
    if out == root:
        raise ValueError('build output must not equal source root; use a separate output directory')
    out.mkdir(parents=True,exist_ok=True)
    write_json(out / 'validation.json',report)
    if not report['passed']:
        print(json.dumps(report,ensure_ascii=False,indent=2))
        return 1
    template = (ASSETS/'course.html').read_text(encoding='utf-8')
    css = (ASSETS/'course.css').read_text(encoding='utf-8')
    js = (ASSETS/'course.js').read_text(encoding='utf-8')
    data = json.dumps(cooked,ensure_ascii=False,allow_nan=False).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026').replace('\u2028','\\u2028').replace('\u2029','\\u2029')
    for token in ('__COURSE_DATA__','__COURSE_CSS__','__COURSE_JS__'):
        if template.count(token) != 1:
            raise ValueError(f'template must contain {token} exactly once')
    page = template.replace('__COURSE_CSS__',css).replace('__COURSE_JS__',js).replace('__COURSE_DATA__',data)
    if len(page.encode('utf-8')) > 24*1024*1024:
        raise ValueError('HTML exceeds 24 MiB; divide course into subsystem volumes')
    (out/'index.html').write_text(page,encoding='utf-8')
    lock = json.loads(json.dumps(cooked,ensure_ascii=False))
    lock.pop('build',None)
    for ref in lock['evidence']:
        for key in ('lines','sha256','language','encoding'):
            ref.pop(key,None)
    write_json(out/'course.lock.json',lock)
    print(json.dumps({'html': str(out/'index.html'), 'lock': str(out/'course.lock.json'), 'validation': str(out/'validation.json'), 'chapters': report['chapters'], 'evidence': report['evidence'], 'bytes': len(page.encode('utf-8'))},ensure_ascii=False))
    return 0

def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--version',action='version',version=VERSION)
    sub = p.add_subparsers(dest='command',required=True)
    scan = sub.add_parser('index',help='bounded, local file inventory; no execution or network')
    scan.add_argument('--source',required=True)
    scan.add_argument('--out',required=True)
    scan.add_argument('--exclude',action='append',default=[])
    scan.add_argument('--max-files',type=int,default=50000)
    scan.add_argument('--max-file-bytes',type=int,default=8*1024*1024)
    scan.add_argument('--max-total-bytes',type=int,default=256*1024*1024)
    scan.set_defaults(func=cmd_index)
    search = sub.add_parser('search',help='bounded literal source search with hash check')
    search.add_argument('--source',required=True)
    search.add_argument('--index',required=True)
    search.add_argument('--text',required=True)
    search.add_argument('--module')
    search.add_argument('--context',type=int,default=3)
    search.add_argument('--limit',type=int,default=12)
    search.add_argument('--max-chars',type=int,default=16000)
    search.add_argument('--max-file-bytes',type=int,default=8*1024*1024)
    search.set_defaults(func=cmd_search)
    brief = sub.add_parser('brief',help='bounded module investigation brief, not an invented lesson')
    brief.add_argument('--index',required=True)
    brief.add_argument('--module')
    brief.add_argument('--max-chars',type=int,default=16000)
    brief.add_argument('--out')
    brief.set_defaults(func=cmd_brief)
    excerpt = sub.add_parser('excerpt',help='exact, line-numbered source excerpt')
    excerpt.add_argument('--source',required=True)
    excerpt.add_argument('--path',required=True)
    excerpt.add_argument('--start',type=int,required=True)
    excerpt.add_argument('--end',type=int,required=True)
    excerpt.add_argument('--max-file-bytes',type=int,default=8*1024*1024)
    excerpt.set_defaults(func=cmd_excerpt)
    for name, func in (('validate',cmd_validate),('build',cmd_build)):
        child = sub.add_parser(name)
        child.add_argument('--source',required=True)
        child.add_argument('--course',required=True)
        child.add_argument('--max-file-bytes',type=int,default=8*1024*1024)
        child.add_argument('--out',required=name=='build') if name=='build' else child.add_argument('--report')
        child.set_defaults(func=func)
    return p

def main(argv=None):
    args = parser().parse_args(argv)
    for name in ('max_files','max_file_bytes','max_total_bytes','limit','max_chars'):
        if hasattr(args,name) and getattr(args,name) <= 0:
            print(f'error: {name} must be positive',file=sys.stderr)
            return 2
    if hasattr(args,'context') and args.context < 0:
        print('error: context must be nonnegative',file=sys.stderr)
        return 2
    try:
        return args.func(args) or 0
    except (OSError,ValueError,KeyError,TypeError,AttributeError) as exc:
        print(f'error: {exc}',file=sys.stderr)
        return 2

if __name__ == '__main__':
    sys.exit(main())
