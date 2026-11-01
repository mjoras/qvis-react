module qloggen

go 1.26.0

require github.com/quic-go/quic-go v0.64.1

require (
	github.com/quic-go/qpack v0.6.0 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/net v0.56.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.40.0 // indirect
)

// quic-go v0.64.1 with quic-go-v0.64.1-qlog-latest.patch applied (see README.md).
// generate.sh clones and patches it into ./quic-go if that directory doesn't exist.
replace github.com/quic-go/quic-go => ./quic-go
