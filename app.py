import subprocess
import sys


def run_command(command, cwd=None):
    process = subprocess.Popen(command, cwd=cwd, shell=True)
    return process


if __name__ == "__main__":
    vite_process = run_command("npm run dev", cwd="static")
    flask_process = run_command("python main.py", cwd="app")

    try:
        vite_process.wait()
        flask_process.wait()
    except KeyboardInterrupt:
        print("Stopping servers...")
        vite_process.terminate()
        flask_process.terminate()
        sys.exit(0)
