
     let b = $response.body;
     if (typeof b === "string" && b.includes("<head>")) {
       b = b.replace("<head>", "<head><script>window.open=function(){return{closed:true}};</script>");
     }
     $done({ body: b });
