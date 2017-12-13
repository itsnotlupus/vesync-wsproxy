FROM node:carbon-alpine

RUN apk update && apk upgrade && \
    apk add --no-cache drill git && \
    drill server2.vesync.com. @8.8.8.8 \
	| awk '/^server2.vesync.com/{print $NF " " $1}' >>/etc/hosts

USER node
RUN mkdir /home/node/app
WORKDIR /home/node/app
COPY --chown=node:node . .
RUN mkdir logs && ln -s /dev/stdout ./logs/server.log && \
    npm install -q state@0.2.* typings@2.1.* ts-node@4.0.* && \
    ln -s ./node_modules/state/ ./state && \
    npm install -q

EXPOSE 16522 17273
CMD [ "npm", "run", "build:live" ]
