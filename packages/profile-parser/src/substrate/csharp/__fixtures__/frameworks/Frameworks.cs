using AutoMapper;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Polly;
using Quartz;
namespace Example;
public class Worker : IHostedService {
  public Task StartAsync(CancellationToken ct) => Task.CompletedTask;
  public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
public class UnregisteredWorker : IHostedService {
  public Task StartAsync(CancellationToken ct) => Task.CompletedTask;
  public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
public class ReportJob : IJob { public Task Execute(IJobExecutionContext context) => Task.CompletedTask; }
public class UnregisteredJob : IJob { public Task Execute(IJobExecutionContext context) => Task.CompletedTask; }
public class ChatHub : Hub {
  public string Send(string message) => message;
  private void Internal() {}
  public override Task OnConnectedAsync() => Task.CompletedTask;
}
public class UnregisteredHub : Hub { public string Send(string message) => message; }
public class Input { public string Name { get; set; } = ""; }
public class Output { public string Name { get; set; } = ""; }
public class Transformation(IMapper mapper, ResiliencePipeline pipeline) {
  public Output Map(Input input) => mapper.Map<Input, Output>(input);
  public void Run() => pipeline.Execute(() => Work());
  private void Work() {}
}
public static class Registration {
  public static void Register(IServiceCollection services, IEndpointRouteBuilder endpoints) {
    services.AddHostedService<Worker>();
    services.AddQuartz((IServiceCollectionQuartzConfigurator q) => {
      q.AddJob<ReportJob>(j => j.StoreDurably());
    });
    services.AddSignalR();
    endpoints.MapHub<ChatHub>("/chat");
  }
}
