using Microsoft.Extensions.DependencyInjection;
namespace Example;
public interface IService { string Send(string value); }
public class Service : IService { public string Send(string value) => value; public int Send(int value) => value; }
public class Other : IService { public string Send(string value) => value; }
public interface IAmbiguous { void Run(); }
public class First : IAmbiguous { public void Run() {} }
public class Second : IAmbiguous { public void Run() {} }
public interface IFactory { void Run(); }
public class FactoryProduct : IFactory { public void Run() {} }
public class Worker(IService service, IAmbiguous ambiguous, IFactory factory) {
  public string Send() => service.Send("message");
  public string Parameter(IService service) => service.Send("parameter");
  public string Explicit() { IService exact = new Other(); return exact.Send("explicit"); }
  public void Ambiguous() => ambiguous.Run();
  public void Factory() => factory.Run();
}
public static class Registration {
  public static void Register(IServiceCollection services) {
    services.AddSingleton<IService, Service>();
    services.AddSingleton<IAmbiguous, First>();
    services.AddSingleton<IAmbiguous, Second>();
    services.AddSingleton<IFactory, FactoryProduct>();
    services.AddSingleton<IFactory>(_ => new FactoryProduct());
  }
}
