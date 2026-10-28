#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf test/extension-test
cp -R extension test/extension-test
python3 - <<'PY'
import json
p='test/extension-test/manifest.json'
m=json.load(open(p))
m['content_scripts'][0]['matches']=['http://127.0.0.1:8899/*']
m['host_permissions']=['http://127.0.0.1:8899/*']
m['web_accessible_resources'][0]['matches']=['http://127.0.0.1:8899/*']
json.dump(m,open(p,'w'),ensure_ascii=False,indent=2)
PY
echo "test extension built"
