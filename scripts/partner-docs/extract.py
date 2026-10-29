"""Extrae del código la parte de la especificación que no se escribe a mano:
rutas, permisos, límites de tasa y esquemas de entrada (DTOs de class-validator)."""
import glob
import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'apps', 'api', 'src')
CONTROLLER = os.path.join(SRC, 'partner-api', 'partner-api.controller.ts')


def read(path):
    return open(path, encoding='utf-8').read()


# ───────────────────────── rutas ─────────────────────────

def routes():
    text = read(CONTROLLER)
    default_throttle = re.search(r"@Throttle\((\d+),\s*(\d+)\)\s*\nexport class", text)
    default_limit = (int(default_throttle.group(1)), int(default_throttle.group(2))) if default_throttle else (None, None)
    body = text[text.index('export class'):]
    # cada ruta empieza en su decorador HTTP; el cuerpo llega hasta el siguiente
    chunks = re.split(r"\n  (?=@(?:Get|Post|Put|Patch|Delete)\()", body)
    out = []
    for chunk in chunks[1:]:
        m = re.match(r"@(Get|Post|Put|Patch|Delete)\('([^']*)'\)", chunk)
        if not m:
            continue
        method, path = m.group(1).upper(), '/' + re.sub(r':(\w+)', r'{\1}', m.group(2))
        scopes = re.search(r"@RequirePartnerScopes\(([^)]*)\)", chunk)
        throttle = re.search(r"@Throttle\((\d+),\s*(\d+)\)", chunk)
        sig = chunk[chunk.index('async '):]
        sig = sig[:sig.index('): Promise')] if '): Promise' in sig else sig[:400]
        op = {
            'method': method,
            'path': path,
            'scopes': re.findall(r"'([^']+)'", scopes.group(1)) if scopes else [],
            'limit': (int(throttle.group(1)), int(throttle.group(2))) if throttle else default_limit,
            'idempotent': "@Headers('idempotency-key')" in chunk,
            'file_field': (re.search(r"FileInterceptor\('(\w+)'", chunk) or [None, None])[1],
            'body_dto': (re.search(r"@Body\(\)\s*\w+:\s*(\w+)", sig) or [None, None])[1],
            'query_dto': (re.search(r"@Query\(\)\s*\w+:\s*(\w+)", sig) or [None, None])[1],
            'handler': re.search(r"async (\w+)\(", chunk).group(1),
        }
        out.append(op)
    return out


# ───────────────────────── DTOs ─────────────────────────

def _class_blocks():
    blocks = {}
    for path in glob.glob(os.path.join(SRC, '**', 'dto', '*.ts'), recursive=True) + [os.path.join(SRC, 'partner-api', 'dto', 'partner-api.dto.ts')]:
        text = read(path)
        for m in re.finditer(r"(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{", text):
            start = m.end()
            depth, i = 1, start
            while depth and i < len(text):
                depth += {'{': 1, '}': -1}.get(text[i], 0)
                i += 1
            blocks[m.group(1)] = {'extends': m.group(2), 'body': text[start:i - 1], 'file': path}
    return blocks


def _enums():
    """Valores de los enums de Prisma y de @shared/types."""
    values = {}
    schema = read(os.path.join(ROOT, 'apps', 'api', 'prisma', 'schema.prisma'))
    for m in re.finditer(r"enum (\w+) \{([^}]*)\}", schema):
        values[m.group(1)] = [ln.strip() for ln in m.group(2).splitlines() if ln.strip() and not ln.strip().startswith('//')]
    for path in glob.glob(os.path.join(ROOT, 'packages', 'shared', '**', '*.ts'), recursive=True):
        text = read(path)
        for m in re.finditer(r"export enum (\w+) \{([^}]*)\}", text):
            vals = re.findall(r"=\s*'([^']+)'", m.group(2))
            if vals:
                values[m.group(1)] = vals
    return values


def _constant_lists():
    """Listas usadas con @IsIn(CONSTANTE): se leen de su definición."""
    out = {}
    for path in [os.path.join(SRC, 'partner-api', 'partner-webhook.events.ts'), os.path.join(SRC, 'partner-api', 'partner-api.scopes.ts')]:
        text = read(path)
        for m in re.finditer(r"export const (\w+) = \[([^\]]*)\] as const", text, re.S):
            out[m.group(1)] = re.findall(r"'([^']+)'", m.group(2))
    commerce = os.path.join(SRC, 'partner-api', 'dto', 'partner-commerce.dto.ts')
    if os.path.exists(commerce):
        for m in re.finditer(r"export const (\w+) = \[([^\]]*)\] as const", read(commerce), re.S):
            out[m.group(1)] = re.findall(r"'([^']+)'", m.group(2))
    shared = glob.glob(os.path.join(ROOT, 'packages', 'shared', '**', '*.ts'), recursive=True)
    for path in shared:
        text = read(path)
        m = re.search(r"ALLOWED_TYPES:\s*\[([^\]]*)\]", text)
        if m:
            out['FILE_CONSTRAINTS.ALLOWED_TYPES'] = re.findall(r"'([^']+)'", m.group(1))
        m = re.search(r"MAX_SIZE:\s*([\d* ]+)", text)
        if m:
            try:
                out['FILE_CONSTRAINTS.MAX_SIZE'] = eval(m.group(1).strip().rstrip(','), {'__builtins__': {}})
            except Exception:
                pass
    return out


BLOCKS = _class_blocks()
ENUMS = _enums()
CONSTS = _constant_lists()


def _num(token, default=None):
    token = str(token).strip()
    if re.fullmatch(r"[\d_.]+", token):
        token = token.replace('_', '')
    try:
        return int(token)
    except ValueError:
        try:
            return float(token)
        except ValueError:
            return CONSTS.get(token, default)


def _balanced(text, i):
    """Índice justo después del paréntesis que cierra al que abre en text[i]."""
    depth, j, quote = 0, i, None
    while j < len(text):
        ch = text[j]
        if quote:
            if ch == '\\':
                j += 1
            elif ch == quote:
                quote = None
        elif ch in '\'"`':
            quote = ch
        elif ch == '/' and text[j + 1:j + 2] not in ('/', '*') and re.match(r"[\s(,]", text[j - 1:j] or ' ') and depth:
            # literal de expresión regular dentro de un decorador
            k, in_class = j + 1, False
            while k < len(text) and (in_class or text[k] != '/'):
                if text[k] == '\\':
                    k += 2
                    continue
                if text[k] == '[':
                    in_class = True
                elif text[k] == ']':
                    in_class = False
                k += 1
            j = k
        elif ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return j


def _members(body):
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    body = re.sub(r"^\s*//.*$", "", body, flags=re.M)
    out, i = [], 0
    while i < len(body):
        while i < len(body) and body[i].isspace():
            i += 1
        decorators = []
        while body[i:i + 1] == '@':
            j = i + 1
            while j < len(body) and (body[j].isalnum() or body[j] == '_'):
                j += 1
            name = body[i + 1:j]
            args = ''
            if body[j:j + 1] == '(':
                k = _balanced(body, j)
                args = body[j + 1:k - 1]
                j = k
            decorators.append((name, args))
            i = j
            while i < len(body) and body[i].isspace():
                i += 1
        m = re.match(r"(\w+)(\?)?(?::\s*|\s*(?==))", body[i:])
        if not m:
            i += 1
            continue
        i += m.end()
        has_type = body[m.start() + i - m.end():i].rstrip().endswith(':') if False else (':' in m.group(0))
        depth, j = 0, i
        while j < len(body):
            ch = body[j]
            if ch in '([{<':
                depth += 1
            elif ch in ')]}>':
                depth -= 1
            elif ch == ';' and depth <= 0:
                break
            j += 1
        decl = body[i:j].strip()
        i = j + 1
        default = None
        if not has_type:
            default, decl = decl.lstrip('=').strip(), ''
        elif '=' in decl and not decl.startswith('{'):
            decl, default = [x.strip() for x in decl.split('=', 1)]
        out.append({'name': m.group(1), 'optional': bool(m.group(2)), 'type': decl, 'default': default, 'decorators': decorators})
    return out


def _each(args):
    return bool(re.search(r"each\s*:\s*true", args))


def _member_schema(member):
    sch, items, nested, nullable = {}, {}, None, False
    optional = member['optional']
    is_array = member['type'].rstrip().endswith('[]') or member['type'].strip().startswith('[')
    ts = member['type']
    if not ts and member['default'] is not None:
        ts = 'number' if re.fullmatch(r"[\d._-]+", member['default']) else 'string'
    nullable = 'null' in ts
    for name, args in member['decorators']:
        each = _each(args)
        target = items if (each and name not in ('ArrayMinSize', 'ArrayMaxSize', 'IsArray')) else sch
        if name == 'IsOptional': optional = True
        elif name == 'IsString': target['type'] = 'string'
        elif name == 'IsInt': target['type'] = 'integer'
        elif name == 'IsNumber': target['type'] = 'number'
        elif name == 'IsBoolean': target['type'] = 'boolean'
        elif name == 'IsObject': target['type'] = 'object'
        elif name == 'IsEmail': target.update({'type': 'string', 'format': 'email'})
        elif name == 'IsUUID': target.update({'type': 'string', 'format': 'uuid'})
        elif name == 'IsDateString': target.update({'type': 'string', 'format': 'date-time'})
        elif name == 'IsUrl': target.update({'type': 'string', 'format': 'uri'})
        elif name == 'IsHexColor': target.update({'type': 'string', 'pattern': '^#[0-9a-fA-F]{6}$'})
        elif name == 'IsEnum': target.update({'type': 'string', 'enum': ENUMS.get(args.strip(), [])})
        elif name == 'IsIn' and re.match(r"\s*[\w.]+", args) and not args.strip().startswith('['):
            first = re.match(r"\s*([\w.]+)", args).group(1)
            vals = CONSTS.get(first, [])
            target.update({'type': 'string', 'enum': vals})
        elif name == 'IsIn':
            first = re.match(r"\s*(\[[^\]]*\]|[\w.]+)", args).group(1)
            vals = re.findall(r"'([^']+)'", first) if first.startswith('[') else CONSTS.get(first, [])
            target.update({'type': 'string', 'enum': vals})
        elif name == 'MinLength': target['minLength'] = _num(args.split(',')[0])
        elif name == 'MaxLength': target['maxLength'] = _num(args.split(',')[0])
        elif name == 'Min': target['minimum'] = _num(args.split(',')[0])
        elif name == 'Max': target['maximum'] = _num(args.split(',')[0])
        elif name == 'Matches':
            mt = re.match(r"\s*/(.+)/[a-z]*\s*(?:,|$)", args, re.S)
            if mt: target['pattern'] = mt.group(1)
        elif name == 'ArrayMinSize': sch['minItems'] = _num(args.split(',')[0])
        elif name == 'ArrayMaxSize':
            v = args.split(',')[0].strip()
            sch['maxItems'] = len(CONSTS.get('PARTNER_WEBHOOK_EVENTS', [])) if 'PARTNER_WEBHOOK_EVENTS' in v else _num(v)
        elif name == 'IsArray': is_array = True
        elif name == 'Type':
            mt = re.search(r"=>\s*(\w+)", args)
            if mt and mt.group(1) not in ('Number', 'String', 'Boolean'): nested = mt.group(1)
        elif name == 'ValidateNested': pass
    if is_array:
        scalar_items = dict(items)
        if nested: scalar_items = {'$ref': f'#/components/schemas/{nested}'}
        elif not scalar_items and ts.strip().startswith('string'): scalar_items = {'type': 'string'}
        elif not scalar_items and ts.strip().startswith('[number'): scalar_items = {'type': 'number'}
        arr = {k: v for k, v in sch.items() if k in ('minItems', 'maxItems')}
        arr.update({'type': 'array', 'items': scalar_items})
        sch = arr
    elif nested:
        sch = {'$ref': f'#/components/schemas/{nested}'}
    if not sch.get('type') and '$ref' not in sch and 'enum' not in sch:
        base = ts.replace('| null', '').strip()
        sch['type'] = {'number': 'number', 'boolean': 'boolean'}.get(base, 'string')
    if nullable and '$ref' not in sch: sch['nullable'] = True
    return sch, optional


def dto_schema(name):
    """Esquema de un DTO incluida su herencia. Devuelve (schema, nombres de DTOs anidados)."""
    block = BLOCKS[name]
    props, required, deps = {}, [], set()
    if block['extends'] and block['extends'] in BLOCKS:
        parent, pdeps = dto_schema(block['extends'])
        props.update(parent.get('properties', {})); required.extend(parent.get('required', [])); deps |= pdeps
    for member in _members(block['body']):
        sch, optional = _member_schema(member)
        if member['default'] is not None:
            dv = member['default'].strip()
            sch['default'] = _num(dv, dv.strip("'\""))
            optional = True
        if not optional: required.append(member['name'])
        ref = sch.get('$ref') or sch.get('items', {}).get('$ref')
        if ref: deps.add(ref.split('/')[-1])
        props[member['name']] = sch
    schema = {'type': 'object', 'properties': props}
    if required: schema['required'] = sorted(set(required))
    return schema, deps


if __name__ == '__main__':
    import json
    rs = routes()
    print(len(rs), 'rutas')
    for r in rs[:6]:
        print(r)
    for dto in ('CreateEventDto', 'PresignBatchDto', 'PartnerBibSearchQueryDto', 'CreatePartnerWebhookDto', 'AttachEventSponsorDto', 'PartnerBulkDownloadDto'):
        print(dto, json.dumps(dto_schema(dto)[0], ensure_ascii=False)[:600])
