scp dist\instantshit.tar.gz pazka@hosh.it:~/serious/InstantShit

scp mount-image.sh pazka@hosh.it:~/serious/InstantShit

ssh pazka@hosh.it "chmod 777 ~/serious/InstantShit/mount-image.sh"
ssh pazka@hosh.it "cd ~/serious/InstantShit && ./mount-image.sh"