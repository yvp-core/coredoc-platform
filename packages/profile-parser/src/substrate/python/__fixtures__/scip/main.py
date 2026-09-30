class Worker:
    def perform(self) -> int:
        return 42
def make() -> Worker:
    return Worker()
def run() -> int:
    worker = make()
    unused = worker.perform
    text = "😀"; return make().perform()
