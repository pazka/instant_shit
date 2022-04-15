rm -Rf build
mkdir build
cp -r www build/www
cp *.js build/
cp *.json build/
cp config.prod.json build/config.json
cp Dockerfile build/Dockerfile

cd build

docker build . --no-cache -t instantshit

cd ..

rm -Rf dist
mkdir dist && cd dist && docker save instantshit > instantshit.tar && gzip -v instantshit.tar

cd ..
