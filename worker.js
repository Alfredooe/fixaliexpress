export default {
  async fetch(request, env, ctx) {
    console.log("Worker started processing request");
    var url = new URL(request.url);
    const userAgent = request.headers.get("user-agent");
    console.log("User Agent:", userAgent);

    const ALIEXPRESS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

    const sendDiscordWebhook = async (itemId, title, aliExpressUrl, imageUrl) => {
      if (!env.DISCORD_WEBHOOK) {
        console.log("Discord webhook not configured, skipping notification");
        return;
      }

      try {
        const webhookPayload = {
          embeds: [{
            title: "AliExpress Embed Generated",
            description: `Successfully generated embed for: ${title}`,
            color: 0xFF0000, // Red color
            fields: [
              {
                name: "Item ID",
                value: itemId,
                inline: true
              },
              {
                name: "AliExpress URL",
                value: aliExpressUrl,
                inline: false
              }
            ],
            image: {
              url: imageUrl
            },
            timestamp: new Date().toISOString()
          }]
        };

        const webhookResponse = await fetch(env.DISCORD_WEBHOOK, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(webhookPayload)
        });

        if (webhookResponse.ok) {
          console.log("Discord webhook sent successfully");
        } else {
          console.error("Failed to send Discord webhook:", webhookResponse.status);
        }
      } catch (error) {
        console.error("Error sending Discord webhook:", error);
      }
    };

    // If the url matches being a `a.aliexpress.com/<random>` link
    // then we need to request it and get the redirect it points to.
    if ( url.href.match(/a\.alimbedxpress\.com\/.*/) ) {
      const test_response = await fetch(`https://a.aliexpress.com/${url.pathname}`, {
        redirect: 'manual',
        headers: {
          'User-Agent': ALIEXPRESS_UA
        }
      });
      // These links just redirect straight through to a /item/ url
      url = new URL(test_response.headers.get("location"));

      // Normalize to the US AliExpress domain for consistency.
      if (url.hostname.endsWith('aliexpress.com')) {
        url.hostname = 'www.aliexpress.us';
      }
    }
    
    const match = url.pathname.match(/\/(item|i)\/(\d+)\.html/);
    if (!match) {
      console.log("Invalid URL format:", url.pathname);
      return new Response("Invalid URL format", { status: 400 });
    }
    
    const itemId = match[2];
  const aliExpressUrl = `https://www.aliexpress.us/item/${itemId}.html`;
    console.log("AliExpress URL:", aliExpressUrl);
    let title = 'AliExpress Product';
    let description = `Item ID: ${itemId}`;
    let imageUrl = "https://ae01.alicdn.com/kf/Sb900db0ad7604a83b297a51d9222905bm/624x160.png";

    try {
      console.log("Fetching AliExpress page");

      var aliexpressAttempts = 1;
      var response;
      while (true) {
        response = await fetch(aliExpressUrl, {
          redirect: 'manual',
          headers: {
            'User-Agent': ALIEXPRESS_UA
          }
        });

        console.log(`AliExpress response status (Attempt ${aliexpressAttempts}/5): ${response.status}`);
        
        if (response.ok) {
          break;
        }
        if ( aliexpressAttempts >= 5 ) {
          break;
        }
        aliexpressAttempts++;
      }

      if (response.ok) {
        const html = await response.text();
        console.log("AliExpress HTML length:", html.length);

        const getMetaContent = (name) => {
          const match = html.match(new RegExp(`<meta\\s+property="og:${name}"\\s+content="([^"]*)"`, 'i'));
          console.log(`Extracting og:${name}:`, match ? match[1] : "Not found");
          return match ? match[1] : null;
        };

        title = getMetaContent('title') || title;
        description = getMetaContent('description') || description;
        imageUrl = getMetaContent('image') || imageUrl;
      } else {
        console.log("Failed to fetch AliExpress page, using fallback data");
      }
    } catch (error) {
      console.error("Error fetching AliExpress page:", error);
      console.log("Using fallback data due to error");
    }

    if (userAgent && userAgent.includes("Discord")) {
      console.log("Preparing Discord embed");
      const color = "#FF0000"; // Theme color

      const embedHtml = `<html>
<head>
  <title>${title}</title>
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="theme-color" content="${color}">
  <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
  <meta property="og:site_name" content="alimbedxpress.com created by alf">
  <meta name="twitter:title" content="AliExpress - ${itemId}" />
  <meta name="twitter:image" content="${imageUrl}" />
  <meta name="twitter:creator" content="@aliexpress" />
  <meta property="og:description" content="${title}" />
</head>
<body>
  <h1>${title}</h1>
  <p>${description}</p>
  <p>Click to view on AliExpresss</p>
  <img src="${imageUrl}" alt="${title}">
</body>
</html>`;

      console.log("Embed HTML length:", embedHtml.length);
      console.log("Returning Discord embed response");
      
      ctx.waitUntil(sendDiscordWebhook(itemId, title, aliExpressUrl, imageUrl));
      
      return new Response(embedHtml, {
        headers: {
          "content-type": "text/html; charset=UTF-8"
        }
      });
    }

    console.log("Redirecting to AliExpress");
    return Response.redirect(aliExpressUrl, 302);
  },
};
