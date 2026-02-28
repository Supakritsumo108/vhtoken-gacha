const { ethers } = require("ethers");

export default async function handler(req, res) {
  // รับ Request เฉพาะแบบ POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userAddress, rewardAmount, nonce } = req.body;

    // ดึง Private Key จาก Vercel Environment Variables
    const privateKey = process.env.SERVER_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("Server configuration error: Missing Private Key");
    }

    const serverWallet = new ethers.Wallet(privateKey);

    // ทำการเซ็น (Sign Message)
    const messageHash = ethers.utils.solidityKeccak256(
      ["address", "uint256", "uint256"],
      [userAddress, rewardAmount, nonce],
    );
    const signature = await serverWallet.signMessage(
      ethers.utils.arrayify(messageHash),
    );

    // ส่ง Signature กลับไปให้ Frontend
    res.status(200).json({ signature });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
