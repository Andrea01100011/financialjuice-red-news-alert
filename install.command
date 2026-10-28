#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "FJ Red News Alert · 安装助手"
echo "----------------------------------------"
echo "即将打开 Chrome 扩展页，并显示扩展文件夹。"
echo ""
echo "在 chrome://extensions 中："
echo "  1. 打开右上角「开发者模式」"
echo "  2. 点击「加载已解压的扩展程序」"
echo "  3. 选择：$DIR/extension"
echo "  4. 回到 FinancialJuice 页面并按 ⌘R 刷新一次"
echo ""
echo "扩展路径已复制到剪贴板，可直接在文件选择框中按 ⌘⇧G 粘贴："
echo "  $DIR/extension"
echo ""

printf '%s' "$DIR/extension" | pbcopy
open "$DIR"
sleep 0.5
open -a "Google Chrome" "chrome://extensions/"
read -r "?按回车关闭此窗口…"
