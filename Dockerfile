FROM node:carbon-alpine

RUN apk update && apk upgrade && \
    apk add --no-cache drill git

USER node
RUN mkdir /home/node/app
WORKDIR /home/node/app
COPY --chown=node:node . .
RUN mkdir -p logs && ln -s /dev/null ./logs/server.log && \
    npm install -q state@0.2.* typings@2.1.* ts-node@4.0.* && \
    ln -s ./node_modules/state/ ./state && \
    npm install -q && \
    npm cache clean --force

EXPOSE 16522 17273
CMD [ "sh", "-c", "REMOTE_IP=$(drill server2.vesync.com. @8.8.8.8 | awk '/^server2.vesync.com/{print $NF;exit}') npm run build:live" ]
# The below requires root to be able to update the hosts file, so if you want to use this then you have to 
# remove the "USER node" line above
#CMD echo 34.204.178.244 server2.vesync.com >>/etc/hosts && REMOTE_IP=server2.vesync.com npm run build:live
