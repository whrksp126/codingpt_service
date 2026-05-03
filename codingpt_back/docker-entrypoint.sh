#!/bin/sh
set -e

if [ "$SKIP_MIGRATIONS" = "1" ]; then
  echo ">>> SKIP_MIGRATIONS=1, db:migrate 건너뜀."
elif [ -d "/app/migrations" ]; then
  echo ">>> sequelize db:migrate..."
  npx sequelize-cli db:migrate
  echo ">>> Migration complete."
else
  echo ">>> migrations 폴더 없음, db:migrate 건너뜀."
fi

echo ">>> Starting app..."
exec "$@"
