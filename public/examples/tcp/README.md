# TCP + TLS + HTTP/2 demo input

`wikipedia_Playstation.json` is the TCP demo file of the original qvis (`visualizations/public/standalone_data/tcp/`): the
`tshark -T json` output of a TLS-decrypted HTTP/2 page load. Upload it in the file manager (Option 2); the built-in
tshark converter turns it into qlog with the private `tcp:`, `tls:` and `http2:` namespaces, which the sequence diagram,
the packetization diagram (TCP mode) and the statistics page can show (converters spec decision C6).

It is part of qvis and is used under its MIT licence:

```
MIT License

Copyright (c) 2019 Hasselt University - EDM

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
