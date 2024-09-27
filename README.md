# three-maze
A VR environment designed for animal behavior research.

## Install
1. Install [Node.js](https://nodejs.org/en)
2. Run ```npm install``` in the `static` directory of the project to install all dependencies.

## Run
1. Run ```npm run dev``` in the root directory of the project to start the server.

## Trouble Shooting
### Access Denied
1. Under Chrome, go to [chrome://net-internals/#sockets](chrome://net-internals/#sockets)

2. Hit the button [Flush socket pools]()

### Port in Use
By default, you need to clean up port `5000` and `5173` for the app.

Run:

``` bash
sudo lsof -i:port # replace 'port' with the port you want to use 
```

To get the PID that is occupying necessary port, and run:

```bash
kill PID
```
