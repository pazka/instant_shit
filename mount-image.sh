#!/bin/sh

# Only for server usage

rm instantshit.tar
gzip -d instantshit.tar.gz
docker stop InstantShit && docker rm InstantShit || docker rm InstantShit
docker load < instantshit.tar
docker run -d -it -p 12121:80 --name InstantShit instantshit