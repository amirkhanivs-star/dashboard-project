(async function () {
  try {
    const meRes = await fetch("/api/me");
    const meJson = await meRes.json();
    const myId = meJson?.user?.id;

    if (!myId) return;

    const socket = io(); // socket.io client must be loaded
    socket.on("user:updated", (payload) => {
      if (payload?.userId === myId) {
        // simplest: reload so new perms apply
        window.location.reload();
      }
    });
  } catch (e) {}
})();
