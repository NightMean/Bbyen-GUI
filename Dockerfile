FROM node:20

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
ADD package*.json ./

RUN npm ci --omit=dev

# Copy app source
COPY . .

# Supply the source commit (optionally suffixed with -dirty) when building.
ARG BBYEN_BUILD_REVISION=unknown
RUN node -e "const fs=require('fs');const v=process.argv[1];if(v!=='unknown'&&!/^[a-f0-9]{7,40}(-dirty)?$/.test(v))process.exit(1);fs.writeFileSync('build-metadata.json',JSON.stringify({revision:v}));" "$BBYEN_BUILD_REVISION"

EXPOSE 3030 3031
CMD [ "npm", "run", "start" ]
