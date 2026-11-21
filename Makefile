.PHONY: build build-web build-linux build-local test clean

build-web:
	npm --prefix web ci
	npm --prefix web run build
	rm -rf go-server/webdist
	mkdir -p go-server/webdist
	cp -R web/dist/. go-server/webdist/
	touch go-server/webdist/.gitkeep

build-linux: build-web
	cd go-server && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/atlasnode-linux-amd64 .
	ls -lh go-server/dist/atlasnode-linux-amd64

build-local: build-web
	cd go-server && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/atlasnode .

build: build-linux

test:
	cd go-server && go test -v ./...

clean:
	rm -rf web/dist go-server/dist go-server/webdist/*
	touch go-server/webdist/.gitkeep
