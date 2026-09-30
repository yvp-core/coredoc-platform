public class Methods {
  public string Choose(string value) => value;
  public T Choose<T>(T value) => value;
  public int Inferred() => Choose(42);
  public int Explicit() => Choose<int>(42);
}