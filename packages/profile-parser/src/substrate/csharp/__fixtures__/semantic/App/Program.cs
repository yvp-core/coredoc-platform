using Example.Domain;
using Microsoft.AspNetCore.Mvc;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<IService, Service>();
var app = builder.Build();
app.MapGet("/health", () => "ok");
app.MapControllers();
app.Run();

[Route("api/[controller]")]
public class MessagesController(IService service) : ControllerBase
{
    [HttpGet("{id}")]
    public string Get(string id) => service.Send(id);
    private int Local(Service exact) => exact.Send(42);
}
