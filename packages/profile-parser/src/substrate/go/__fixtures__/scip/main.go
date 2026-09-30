package example
type Worker struct {}
func (Worker) Perform() int { return 42 }
func Make() Worker { return Worker{} }
func Run() int {
    unused := Worker.Perform; _ = unused
    text := "😀"; _ = text; return Make().Perform()
}
