package example

// #include <stdlib.h>
import "C"

func NativeAbs(n int) int { return int(C.abs(C.int(n))) }
