# Optional container image of the local server (the same server as `npm start`), on port 8080 like the original
# qvis image. Node alone is the lighter way to run qvis-react locally; see README.md "Running locally".
#
#   docker build -t qvis-react .
#   docker run --rm -p 127.0.0.1:8080:8080 qvis-react      then open http://localhost:8080/
#
# Options of the server go after the image name, e.g. `docker run ... qvis-react --allowed-hosts qvis.lab.example`.

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# The server needs only Node: dist/ (the app), dist-server/ (server + proxy) and vercel.json (headers), no node_modules
FROM node:26-alpine
WORKDIR /app
COPY --from=build /app/vercel.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
ENV PORT=8080 QVIS_CONTAINER=1
EXPOSE 8080
ENTRYPOINT ["node", "dist-server/server/local-server.js", "--host", "0.0.0.0"]
