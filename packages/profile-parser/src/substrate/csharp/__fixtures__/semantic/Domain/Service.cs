namespace Example.Domain;
public interface IService { string Send(string value); }
public class Service : IService
{
    public string Send(string value) => value;
    public int Send(int value) => value;
}
