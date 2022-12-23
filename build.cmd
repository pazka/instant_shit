rm -Rf build
mkdir build
cp -r www build/www
cp *.js build/
cp *.json build/
cp config.prod.json build/config.json
cp Dockerfile build/Dockerfile

cd build

docker build . -t pazka/instantshit

docker push pazka/instantshit