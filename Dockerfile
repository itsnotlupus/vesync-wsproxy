FROM node:carbon-alpine

RUN apk update && apk upgrade && \
    apk add --no-cache drill git

USER node
RUN mkdir /home/node/app
WORKDIR /home/node/app
COPY --chown=node:node . .
RUN mkdir logs && ln -s /dev/stdout ./logs/server.log && \
    npm install -q state@0.2.* typings@2.1.* ts-node@4.0.* && \
    ln -s ./node_modules/state/ ./state && \
    npm install -q && \
    npm cache clean --force

EXPOSE 16522 17273
CMD [ "sh", "-c", "REMOTE_IP=$(drill server2.vesync.com. @8.8.8.8 | awk '/^server2.vesync.com/{print $NF \" \" $1}') npm run build:live" ]
