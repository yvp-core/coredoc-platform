using Microsoft.AspNetCore.Mvc;
public class ItemsController : ControllerBase
{
    [HttpGet("/api/v1/items")]
    public string Read() => "items";
}
