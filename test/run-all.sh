#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
node test/i18n.test.js
node test/detector.test.js
node test/translator.test.js
node test/background.test.js
python3 test/page-translation.test.py
echo "all tests passed"
