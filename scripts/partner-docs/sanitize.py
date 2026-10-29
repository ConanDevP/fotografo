"""Convierte la captura cruda (respuestas reales de una API local con datos de prueba) en ejemplos
seguros para publicar: identificadores estables, sin secretos, URLs firmadas abreviadas.

Uso: python3 sanitize.py capture/out/captures.json capture/out/deliveries.json examples.json
"""
import json
import re
import sys
import uuid

NS = uuid.UUID('6f1c2d4e-9a3b-4c5d-8e7f-0a1b2c3d4e5f')
UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.I)
SIGNED_RE = re.compile(r'https://[^"\s/]*r2\.cloudflarestorage\.com/([^"?\s]*)\?[^"\s]*?X-Amz-Expires=(\d+)[^"\s]*')


class Sanitizer:
    def __init__(self):
        self.ids = {}

    def uid(self, match):
        raw = match.group(0).lower()
        if raw == '00000000-0000-4000-8000-000000000000':
            return raw
        if raw not in self.ids:
            self.ids[raw] = str(uuid.uuid5(NS, f'ejemplo-{len(self.ids)}'))
        return self.ids[raw]

    def text(self, value):
        value = SIGNED_RE.sub(lambda m: f'https://storage.example.com/{re.sub(r"^[^/]+/", "", m.group(1)) if m.group(1).startswith("docs-") else m.group(1)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires={m.group(2)}&X-Amz-Signature=<firma>', value)
        value = value.replace('https://storage.example.com/docs-', 'https://storage.example.com/events/original/photo-')
        value = value.replace('https://pub.docs.example', 'https://cdn.example.com')
        value = value.replace('owner@docs.test', 'ops@cronos.example')
        value = re.sub(r'http://localhost:\d+', 'https://app.example.com', value)
        value = re.sub(r'#token=[0-9a-f]{20,}', '#token=<token>', value)
        value = re.sub(r'\?token=\d+\.[0-9a-f]{20,}', '?token=1.<token>', value)
        value = value.replace('/reporte/', '/reporte/')
        value = re.sub(r'\b[0-9a-f]{64}\b', lambda m: '9f2c1b7e5a3d4c68b0e1f2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7' if False else m.group(0), value)
        return UUID_RE.sub(self.uid, value)

    def walk(self, value, key=''):
        if isinstance(value, dict):
            out = {}
            for k, v in value.items():
                if k == 'signingSecret':
                    out[k] = 'whsec_EJEMPLO_NO_USAR_Zk3m9QxLw2Vb8Nc'
                elif k == 'invitationToken':
                    out[k] = '9f2c1b7e5a3d4c68b0e1f2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7'
                elif k in ('uploadUrl', 'downloadUrl') and isinstance(v, str):
                    out[k] = self.text(v)
                else:
                    out[k] = self.walk(v, k)
            return out
        if isinstance(value, list):
            keep = value if all(not isinstance(x, (dict, list)) for x in value) else value[:2]
            return [self.walk(x, key) for x in keep]
        if isinstance(value, str):
            if key == 'content' and '\n' in value:
                lines = value.split('\n')
                value = '\n'.join(lines[:4]) + ('\n…' if len(lines) > 4 else '')
            return self.text(value)
        return value


def main(captures_path, deliveries_path, out_path):
    raw = json.load(open(captures_path))['caps']
    deliveries = json.load(open(deliveries_path))
    s = Sanitizer()
    caps = []
    for c in raw:
        caps.append({
            'op': c['op'], 'method': c['method'], 'path': s.text(c['path']), 'query': c['query'],
            'request': s.walk(c['request']) if c['request'] is not None else None,
            'status': c['status'], 'response': s.walk(c['response']), 'note': c.get('note', ''),
        })
    hooks = {}
    for d in deliveries:
        hooks.setdefault(d['eventType'], {'id': s.text(d['eventId']), 'createdAt': d['createdAt'], 'data': s.walk(d['payload'])})
    json.dump({'captures': caps, 'webhooks': hooks}, open(out_path, 'w'), ensure_ascii=False, indent=1)
    print(len(caps), 'capturas,', len(hooks), 'eventos de webhook,', len(s.ids), 'ids distintos')


if __name__ == '__main__':
    main(*sys.argv[1:4])
