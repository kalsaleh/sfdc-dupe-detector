#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"

echo "Creating virtual environment in ${VENV_DIR}"
python3 -m venv "${VENV_DIR}"

echo "Activating virtual environment"
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

echo "Installing Python dependencies"
pip install --upgrade pip
pip install -r "${ROOT_DIR}/requirements.txt"

if [ ! -f "${ROOT_DIR}/.env" ]; then
  echo "Creating .env from .env.example"
  cp "${ROOT_DIR}/.env.example" "${ROOT_DIR}/.env"
else
  echo ".env already exists, leaving it unchanged"
fi

echo "Installing Playwright Chromium browser"
python -m playwright install chromium

cat <<EOF

Setup complete.

Next steps:
  1. Review ${ROOT_DIR}/.env
  2. Review ${ROOT_DIR}/config/matching_rules.json
  3. Activate the environment:
       source ${VENV_DIR}/bin/activate
  4. Start the app:
       python -m backend.main

EOF
