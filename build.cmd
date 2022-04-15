rm -Rf build
mkdir build
cp -r www build/www
cp server.js build/server.js
cp server.js build/package.json
cp config.prod.json build/config.json

