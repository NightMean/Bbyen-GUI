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

EXPOSE 3030 3031
CMD [ "npm", "run", "start" ]
