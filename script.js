const tokenAddress = "0xc1b5E4A709670b8f1391d713934d1B80C46B7e1e";
const gachaAddress = "0x4e17e650c601e67e78c5c16D03171f5C95b2156d";

const tokenABI = [
  "function approve(address spender, uint256 tokens) public returns (bool success)",
  "function balanceOf(address tokenOwner) public view returns (uint256 balance)",
  "function allowance(address owner, address spender) public view returns (uint256)",
];

const gachaABI = [
  "function spinGacha() external",
  "function getMyCards() external view returns (tuple(uint256 id, string rarity, uint256 timestamp, bool isLocked)[])",
  "function burnCard(uint256 tokenId) external",
  "function toggleLock(uint256 cardId) external",
  "function batchToggleLock(uint256[] calldata cardIds) external",
  "function claimBattleReward(uint256 amount, uint256 nonce, bytes signature) external", // [เพิ่มใหม่] ฟังก์ชันรับรางวัล
];

let provider, signer, tokenContract, gachaContract, userAddress;
let allMyCards = [];
let cardToBurn = null;
let currentFilter = "All";
let inventoryChartInstance = null;

// ==========================================
// [เพิ่มใหม่] ตัวแปรสำหรับ Auto Battler
// ==========================================
let battleDeck = [];
// ใส่ Private Key ของกระเป๋าที่ตั้งเป็น battleSigner ใน Smart Contract (ห้ามใช้กระเป๋าหลักเด็ดขาด ใช้เฉพาะ Demo)
const SERVER_PRIVATE_KEY =
  "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d";
// ==========================================

const GACHA_PRICE = 100; // กำหนดราคากาชา
const EXPECTED_CHAIN_ID = "0x61"; // BSC Testnet (97)

const sounds = {
  spinning: new Howl({ src: ["audios/spinning.mp3"], loop: true }),
  congrat: new Howl({ src: ["audios/congrat.mp3"] }),
  legendary: new Howl({ src: ["audios/legendary_bgm.mp3"], loop: true }),
};

const volumeSettings = {
  sfx: 0.5, // ระดับเสียง Effect (0.0 - 1.0)
  bgm: 0.3, // ระดับเสียงเพลงพื้นหลัง (0.0 - 1.0)
};

// ฟังก์ชันควบคุมและอัปเดตระดับเสียง (SFX/BGM) ของเว็บไซต์
function updateVolume() {
  sounds.spinning.volume(volumeSettings.sfx);
  sounds.congrat.volume(volumeSettings.sfx);
  sounds.legendary.volume(volumeSettings.bgm);
}

updateVolume();

function changeVolume(type, value) {
  if (type === "sfx") volumeSettings.sfx = parseFloat(value);
  updateVolume();
}

// ฟังก์ชันสั่งหยุดเสียงทั้งหมดที่กำลังเล่นอยู่
function stopAllSounds() {
  Object.values(sounds).forEach((s) => {
    s.stop();
  });
}

// ฟังก์ชันสำหรับสลับหน้าจอเมนู (Gacha / Inventory / History)
function switchTab(tabName) {
  document
    .querySelectorAll(".content-section")
    .forEach((el) => el.classList.remove("active"));
  document
    .querySelectorAll(".menu-item")
    .forEach((el) => el.classList.remove("active"));
  document.getElementById(`view-${tabName}`).classList.add("active");
  document.getElementById(`menu-${tabName}`).classList.add("active");

  if (tabName === "inventory" && signer) loadMyCards();
  if (tabName === "history") renderHistory();
}

// ฟังก์ชันเปิด-ปิด หน้าจอรอโหลด (Loading Screen)
function showLoader(msg) {
  document.getElementById("loaderText").innerText = msg;
  document.getElementById("loadingOverlay").style.display = "flex";
}
function hideLoader() {
  document.getElementById("loadingOverlay").style.display = "none";
}

// ฟังก์ชันแปลง Error Code จากบล็อกเชนให้เป็นข้อความที่มนุษย์อ่านเข้าใจง่าย
function getFriendlyMessage(error) {
  const msg = error?.message || error?.reason || "";
  if (msg.includes("user rejected")) return "Transaction cancelled by user.";
  if (msg.includes("insufficient funds")) return "Not enough BNB for gas fees.";
  if (msg.includes("allowance")) return "Please approve VH tokens first.";
  if (msg.includes("execution reverted"))
    return "Contract execution failed. Please check your balance.";
  return "Something went wrong. Please try again.";
}

// ฟังก์ชันตรวจสอบว่าผู้ใช้เชื่อมต่อกับเครือข่าย BSC Testnet ถูกต้องหรือไม่
async function checkNetwork() {
  if (!window.ethereum) return false;
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId !== EXPECTED_CHAIN_ID) {
    const result = await Swal.fire({
      title: "Wrong Network",
      text: "Please switch to BSC Testnet to continue.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Switch Network",
      background: "#222",
      color: "#fff",
    });
    if (result.isConfirmed) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: EXPECTED_CHAIN_ID }],
        });
        return true;
      } catch (err) {
        console.error("Switch error", err);
      }
    }
    return false;
  }
  return true;
}

// ฟังก์ชันบันทึกกิจกรรม (สุ่ม/เผา) ลงใน LocalStorage ของ Browser
function addHistory(action, details) {
  const history = JSON.parse(localStorage.getItem("gacha_history") || "[]");
  const newEntry = {
    action: action,
    details: details,
    time: new Date().toLocaleString(),
  };
  history.unshift(newEntry);
  localStorage.setItem("gacha_history", JSON.stringify(history.slice(0, 50)));
  renderHistory();
}

// ฟังก์ชันดึงประวัติมาแสดงผลในหน้า History
function renderHistory() {
  const list = document.getElementById("historyList");
  if (!list) return;
  const history = JSON.parse(localStorage.getItem("gacha_history") || "[]");
  if (history.length === 0) {
    list.innerHTML =
      '<p style="color: #666; text-align: center; padding: 20px;">No recent activity found.</p>';
    return;
  }
  list.innerHTML = history
    .map(
      (item) => `
        <div class="history-item ${item.action.toLowerCase()}">
            <div class="history-info">
                <span class="history-action" style="color: ${item.action === "SUMMON" ? "#eff107" : item.action === "BATTLE" ? "#4ade80" : "#ef4444"}">
                    ${item.action === "SUMMON" ? "🎰 " : item.action === "BATTLE" ? "⚔️ " : "🔥 "}${item.action}
                </span>
                <span class="history-details">${item.details}</span>
            </div>
            <div class="history-time">${item.time}</div>
        </div>
    `,
    )
    .join("");
}

// ฟังก์ชันล้างประวัติการทำรายการทั้งหมดในเครื่อง
function clearHistory() {
  Swal.fire({
    title: "Are you sure?",
    text: "This will clear your local activity log.",
    icon: "warning",
    showCancelButton: true,
    confirmButtonColor: "#ef4444",
    cancelButtonColor: "#333",
    confirmButtonText: "Yes, clear it!",
    background: "#222",
    color: "#fff",
  }).then((result) => {
    if (result.isConfirmed) {
      localStorage.removeItem("gacha_history");
      renderHistory();
    }
  });
}

// ฟังก์ชันเปิด-ปิด หน้าต่างยืนยันการเผาการ์ด
function openBurnModal(id, rarity) {
  cardToBurn = id.toString();
  const idEl = document.getElementById("burnCardId");
  if (idEl) {
    idEl.innerText = `#${
      cardToBurn.length > 10 ? cardToBurn.substring(0, 10) + "..." : cardToBurn
    } (${rarity})`;
  }

  let refundAmount = 10;
  if (rarity === "Rare") refundAmount = 30;
  if (rarity === "Legend") refundAmount = 50;

  const modalBox = document.querySelector("#burnModal .modal-box");
  if (modalBox) {
    const paragraphs = modalBox.querySelectorAll("p");
    if (paragraphs[1]) {
      paragraphs[1].innerHTML = `You will receive <span style="color: #4ade80;">${refundAmount} VH</span> back.`;
    }
  }

  const modal = document.getElementById("burnModal");
  if (modal) modal.style.display = "flex";
}

function closeBurnModal() {
  cardToBurn = null;
  const modal = document.getElementById("burnModal");
  if (modal) modal.style.display = "none";
}

// ฟังก์ชันขยายรูปการ์ดให้ดูแบบเต็มหน้าจอ พร้อมเล่นเพลงประกอบ
function openPreviewModal(rarity, id) {
  const previewModal = document.getElementById("cardPreviewModal");
  const previewImg = document.getElementById("previewImage");

  if (!previewModal || !previewImg) return;

  if (rarity === "Legend") {
    sounds.legendary.stop();
    sounds.legendary.play();
  }

  let bigImage = "";
  const idForImage = BigInt(id);

  if (rarity === "Legend") {
    const variant = Number(idForImage % BigInt(4));
    bigImage = `images/legendary/full_Legend_${variant}.png`;
  } else if (rarity === "Rare") {
    const variant = Number(idForImage % BigInt(6));
    bigImage = `images/rare/full_Rare_${variant}.png`;
  } else {
    const variant = Number(idForImage % BigInt(10));
    bigImage = `images/common/full_Common_${variant}.png`;
  }

  previewImg.src = bigImage;

  previewImg.onerror = function () {
    this.src =
      rarity === "Legend"
        ? `images/legendary/Legend_${Number(idForImage % BigInt(4))}.png`
        : rarity === "Rare"
          ? `images/rare/Rare_${Number(idForImage % BigInt(6))}.png`
          : `images/common/Common_${Number(idForImage % BigInt(10))}.png`;
    this.onerror = null;
  };

  previewModal.style.display = "flex";
}

function closePreviewModal() {
  const previewModal = document.getElementById("cardPreviewModal");
  if (previewModal) previewModal.style.display = "none";
  sounds.legendary.stop();
}

// ฟังก์ชันปิดหน้าจอแสดงผลการ์ดที่เพิ่งสุ่มได้
function closeReveal() {
  document.getElementById("gachaRevealOverlay").style.display = "none";
  sounds.congrat.stop();
  switchTab("inventory");
}

// ฟังก์ชันดึงข้อมูลการ์ดใบใหม่ล่าสุดมาโชว์ พร้อมเอฟเฟกต์สั่นจอและเสียงประกอบ
async function showGachaReveal() {
  try {
    const cards = await gachaContract.getMyCards();
    if (cards.length === 0) return;

    const lastCard = cards[cards.length - 1];
    const rarity = lastCard.rarity;
    const id = lastCard.id.toString();
    const idForImage = BigInt(id);

    const tokenIdEl = document.getElementById("revealTokenId");
    const timeEl = document.getElementById("revealTime");

    if (tokenIdEl)
      tokenIdEl.innerText = `#${id.substring(0, 10)}${id.length > 10 ? "..." : ""}`;
    if (timeEl) timeEl.innerText = new Date().toLocaleString();

    document.body.classList.add("screen-shake");
    setTimeout(() => {
      document.body.classList.remove("screen-shake");
    }, 500);

    sounds.spinning.stop();
    sounds.congrat.stop();
    sounds.congrat.play();

    addHistory("SUMMON", `Received ${rarity} Card #${id.substring(0, 6)}`);

    let cardImgPath = "";
    const rarityTextEl = document.getElementById("revealRarityText");
    playLegendConfetti();

    if (rarity === "Legend") {
      cardImgPath = `images/legendary/Legend_${Number(idForImage % BigInt(4))}.png`;
      if (rarityTextEl) rarityTextEl.style.color = "#ff4dff";
    } else if (rarity === "Rare") {
      cardImgPath = `images/rare/Rare_${Number(idForImage % BigInt(6))}.png`;
      if (rarityTextEl) rarityTextEl.style.color = "#00d4ff";
    } else {
      cardImgPath = `images/common/Common_${Number(idForImage % BigInt(10))}.png`;
      if (rarityTextEl) rarityTextEl.style.color = "#ffffff";
    }

    const container = document.getElementById("revealCardContainer");
    if (container) {
      container.innerHTML = `<img src="${cardImgPath}" onerror="this.src='images/default_full.png'" style="max-width:100%; border-radius:15px; box-shadow: 0 0 20px rgba(255,255,255,0.5);">`;
    }

    if (rarityTextEl)
      rarityTextEl.innerText = `YOU GOT ${rarity.toUpperCase()}!`;

    document.getElementById("gachaRevealOverlay").style.display = "flex";

    updateQuickSummary(cards);
  } catch (err) {
    console.error("Reveal Error:", err);
  }
}

// ฟังก์ชันคำนวณเปอร์เซ็นต์ความสำเร็จในการสะสมการ์ด (Collection %)
function updateCollectionProgress(cards) {
  const TOTAL_COMMON = 10;
  const TOTAL_RARE = 6;
  const TOTAL_LEGEND = 4;
  const MAX_SCORE = TOTAL_COMMON + TOTAL_RARE + TOTAL_LEGEND;

  const ownedCommon = new Set();
  const ownedRare = new Set();
  const ownedLegend = new Set();

  cards.forEach((c) => {
    const idVal = BigInt(c.id.toString());

    if (c.rarity === "Legend") {
      const variant = Number(idVal % BigInt(TOTAL_LEGEND));
      ownedLegend.add(variant);
    } else if (c.rarity === "Rare") {
      const variant = Number(idVal % BigInt(TOTAL_RARE));
      ownedRare.add(variant);
    } else {
      const variant = Number(idVal % BigInt(TOTAL_COMMON));
      ownedCommon.add(variant);
    }
  });

  const countCommon = ownedCommon.size;
  const countRare = ownedRare.size;
  const countLegend = ownedLegend.size;
  const totalUniqueOwned = countCommon + countRare + countLegend;

  let percent = 0;
  if (MAX_SCORE > 0) {
    percent = Math.floor((totalUniqueOwned / MAX_SCORE) * 100);
  }

  const elCommon = document.getElementById("commonCount");
  const elRare = document.getElementById("rareCount");
  const elLegend = document.getElementById("legendCount");
  const elPercent = document.getElementById("totalPercent");
  const elBar = document.getElementById("totalProgressBar");

  if (elCommon) elCommon.innerText = `${countCommon}/${TOTAL_COMMON}`;
  if (elRare) elRare.innerText = `${countRare}/${TOTAL_RARE}`;
  if (elLegend) elLegend.innerText = `${countLegend}/${TOTAL_LEGEND}`;

  if (elPercent) elPercent.innerText = `${percent}%`;
  if (elBar) elBar.style.width = `${percent}%`;
}

// ฟังก์ชันสร้างกราฟวงกลม (Donut Chart) แสดงสัดส่วนการ์ดที่มี
function renderInventoryChart(cards) {
  const commonCount = cards.filter((c) => c.rarity === "Common").length;
  const rareCount = cards.filter((c) => c.rarity === "Rare").length;
  const legendCount = cards.filter((c) => c.rarity === "Legend").length;

  if (!inventoryChartInstance) {
    const options = {
      series: [commonCount, rareCount, legendCount],
      labels: ["Common", "Rare", "Legend"],
      colors: ["#9ca3af", "#3b82f6", "#eab308"], // เทา, ฟ้า, ทอง
      chart: {
        type: "donut",
        width: "100%",
        height: 250,
        background: "transparent",
        animations: { enabled: true },
      },
      theme: { mode: "dark" },
      stroke: { show: false },
      dataLabels: { enabled: false },
      legend: {
        position: "bottom",
        fontSize: "14px",
        fontFamily: "Rajdhani, sans-serif",
      },
      plotOptions: {
        pie: {
          donut: {
            size: "65%",
            labels: {
              show: true,
              total: {
                show: true,
                label: "TOTAL",
                color: "#fff",
                formatter: function (w) {
                  return w.globals.seriesTotals.reduce((a, b) => a + b, 0);
                },
              },
            },
          },
        },
      },
    };

    const chartEl = document.querySelector("#inventoryChart");
    if (chartEl) {
      inventoryChartInstance = new ApexCharts(chartEl, options);
      inventoryChartInstance.render();
    }
  } else {
    inventoryChartInstance.updateSeries([commonCount, rareCount, legendCount]);
  }
}

// ฟังก์ชันอัปเดตตัวเลขจำนวนการ์ดสรุปย่อในหน้าแรก
function updateQuickSummary(cards) {
  const total = cards.length;
  const common = cards.filter((c) => c.rarity === "Common").length;
  const rare = cards.filter((c) => c.rarity === "Rare").length;
  const legend = cards.filter((c) => c.rarity === "Legend").length;

  const elTotal = document.getElementById("quickTotalCards");
  const elCommon = document.getElementById("quickCommon");
  const elRare = document.getElementById("quickRare");
  const elLegend = document.getElementById("quickLegend");

  if (elTotal) elTotal.innerText = total;
  if (elCommon) elCommon.innerText = common;
  if (elRare) elRare.innerText = rare;
  if (elLegend) elLegend.innerText = legend;
}

// ฟังก์ชันหลักที่คัดกรองการ์ดตามเงื่อนไข (คำค้นหา/ระดับความหายาก/ลำดับเวลา)
function handleFilterAndSort() {
  let filtered = [...allMyCards];

  if (currentFilter !== "All") {
    filtered = filtered.filter((c) => c.rarity === currentFilter);
  }

  const searchInput = document.getElementById("cardSearchInput");
  if (searchInput) {
    const searchTerm = searchInput.value.toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((c) =>
        c.id.toString().toLowerCase().includes(searchTerm),
      );
    }
  }

  const sortSelect = document.getElementById("sortSelect");
  if (sortSelect) {
    const sortMode = sortSelect.value;
    const rarityWeight = { Legend: 3, Rare: 2, Common: 1 };

    filtered.sort((a, b) => {
      if (sortMode === "newest") return 0;
      if (sortMode === "oldest") return 0;
      if (sortMode === "rarity-desc")
        return rarityWeight[b.rarity] - rarityWeight[a.rarity];
      if (sortMode === "rarity-asc")
        return rarityWeight[a.rarity] - rarityWeight[b.rarity];
      return 0;
    });

    if (sortMode === "oldest") {
      filtered = [...filtered].reverse();
    }
  }

  renderCards(filtered);
}

// ฟังก์ชันเปลี่ยนหมวดหมู่การ์ดที่จะแสดง (All/Common/Rare/Legend)
function filterCards(rarity, btnElement) {
  document
    .querySelectorAll(".filter-btn")
    .forEach((b) => b.classList.remove("active"));
  btnElement.classList.add("active");

  currentFilter = rarity;
  handleFilterAndSort();
}

// ฟังก์ชันสร้าง HTML Elements เพื่อนำข้อมูลการ์ดออกมาแสดงเป็นรูปธรรม
function renderCards(cards) {
  const list = document.getElementById("cardList");
  if (!list) return;
  list.innerHTML = "";

  if (cards.length === 0) {
    list.innerHTML = "<p style='color:#666'>No cards found.</p>";
    return;
  }

  cards.forEach((c) => {
    const div = document.createElement("div");
    div.className = `card-box ${c.rarity}`;

    const isLocked = c.isLocked;
    const currentId = c.id.toString();
    const idForImage = BigInt(currentId);

    let cardImage = "";
    if (c.rarity === "Legend") {
      const variant = Number(idForImage % BigInt(4));
      cardImage = `images/legendary/Legend_${variant}.png`;
    } else if (c.rarity === "Rare") {
      const variant = Number(idForImage % BigInt(6));
      cardImage = `images/rare/Rare_${variant}.png`;
    } else {
      const variant = Number(idForImage % BigInt(10));
      cardImage = `images/common/Common_${variant}.png`;
    }

    const lockBtnHTML = `
      <button class="btn-lock ${isLocked ? "locked" : "unlocked"}" 
              onclick="toggleLockCard('${currentId}')" 
              title="${isLocked ? "Unlock Card" : "Lock Card"}">
          ${isLocked ? "🔒" : "🔓"}
      </button>
    `;

    const burnBtnHTML = `
        <button class="btn-burn-card" 
            onclick="openBurnModal('${currentId}', '${c.rarity}')" 
            ${isLocked ? 'disabled style="background:#555; cursor:not-allowed; opacity:0.5;"' : ""}>
            🔥 Burn
        </button>
    `;

    // [เพิ่มใหม่] ปุ่มสำหรับเลือกเข้า Deck
    const battleBtnHTML = `
        <button style="margin-top: 8px; width: 100%; padding: 5px; background: rgba(255,255,255,0.1); border: 1px solid #EFF107; color: #EFF107; border-radius: 5px; cursor: pointer;" 
            onclick="toggleBattleCard('${currentId}')" 
            title="Select/Deselect for Battle">
            ⚔️ Add to Deck
        </button>
    `;

    const cardPower = getCardPower(c.rarity, currentId);

    div.innerHTML = `
            <div style="position: absolute; top: 10px; right: 10px; z-index:10;">
                ${lockBtnHTML}
            </div>
            
            <div class="card-image-container" 
                  style="margin-top: 10px; cursor: zoom-in;" 
                  onclick="openPreviewModal('${c.rarity}', '${currentId}')">
                <img src="${cardImage}" alt="${c.rarity}" 
                     onerror="this.src='images/default.png'" 
                     style="width: 100%; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.5);">
            </div>

            <h3 style="margin: 10px 0 0 0; color: #fff;">${c.rarity}</h3>
            <div style="color: #EFF107; font-size: 0.9em; margin-bottom: 5px;">⚔️ ATK: ${cardPower}</div>
            
            <div class="card-id">#${currentId.substring(0, 6)}...</div>
            
            <div style="margin-top: 10px; width: 100%; text-align: center;">
                <a href="#" class="card-link" onclick="window.open('https://testnet.bscscan.com/address/${gachaAddress}', '_blank')">
                    View
                </a>
                ${burnBtnHTML}
                ${battleBtnHTML}
            </div>
        `;
    list.appendChild(div);
  });
  applyTiltEffect();
  initTooltips();
}

// ฟังก์ชันที่ทำให้การ์ดเอียงตามตำแหน่งเมาส์ (3D Tilt Effect)
function applyTiltEffect() {
  const cards = document.querySelectorAll(".card-box");

  cards.forEach((card) => {
    card.addEventListener("mousemove", (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const rotateX = ((y - centerY) / centerY) * -1;
      const rotateY = ((x - centerX) / centerX) * 4;

      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.05, 1.05, 1.05)`;
    });

    card.addEventListener("mouseleave", () => {
      card.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)`;
    });
  });
}

// ฟังก์ชันขออนุญาตเชื่อมต่อกระเป๋า MetaMask
async function connectWallet() {
  if (window.ethereum) {
    try {
      if (!(await checkNetwork())) return;

      provider = new ethers.providers.Web3Provider(window.ethereum);
      await window.ethereum.request({ method: "eth_requestAccounts" });
      signer = provider.getSigner();
      userAddress = await signer.getAddress();

      tokenContract = new ethers.Contract(tokenAddress, tokenABI, signer);
      gachaContract = new ethers.Contract(gachaAddress, gachaABI, signer);

      await updateBalance();
      await loadMyCards();

      const Toast = Swal.mixin({
        toast: true,
        position: "top-end",
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true,
        background: "#222",
        color: "#fff",
      });
      Toast.fire({ icon: "success", title: "Wallet Connected" });
    } catch (error) {
      console.error(error);
      Swal.fire({
        icon: "error",
        title: "Connection Failed",
        text: getFriendlyMessage(error),
        background: "#222",
        color: "#fff",
      });
    }
  } else {
    Swal.fire({
      icon: "error",
      title: "MetaMask Missing",
      text: "Please install MetaMask to play.",
      background: "#222",
      color: "#fff",
    });
  }
}

// ฟังก์ชันดึงยอดเงินเหรียญ VH จากบล็อกเชนมาแสดง
async function updateBalance() {
  if (!tokenContract) return;
  try {
    const rawBalance = await tokenContract.balanceOf(userAddress);
    const balanceNum = parseFloat(ethers.utils.formatUnits(rawBalance, 8));
    const balanceStr = balanceNum.toFixed(2);

    document.getElementById("walletStatusSidebar").innerHTML = `
            <i class="fas fa-check-circle" style="color: #4ade80;"></i> Connected<br>
            <span style="color: #ccc; font-size: 0.8em;">${userAddress.substring(0, 6)}...</span>
            <div class="balance-display">${balanceStr} VH</div>
        `;

    validateSpinAction(balanceNum);
  } catch (e) {
    console.error("Balance Error:", e);
  }
}

// ฟังก์ชันตรวจสอบเงื่อนไข (เงินพอไหม/Approve หรือยัง) เพื่อเปิด-ปิดการใช้งานปุ่มสุ่ม
async function validateSpinAction(currentBalance) {
  const spinBtn = document.getElementById("btnSpin");
  const approveBtn = document.getElementById("btnApprove");
  const warningText = document.getElementById("spinWarningText");

  if (!tokenContract || !userAddress || !spinBtn) return;

  try {
    const allowance = await tokenContract.allowance(userAddress, gachaAddress);
    const allowanceFormatted = parseFloat(
      ethers.utils.formatUnits(allowance, 8),
    );

    if (currentBalance < GACHA_PRICE) {
      spinBtn.disabled = true;
      if (warningText) {
        warningText.innerText = "❌ Insufficient VH Balance";
        warningText.style.color = "#ef4444";
      }
    } else if (allowanceFormatted < GACHA_PRICE) {
      spinBtn.disabled = true;
      if (approveBtn) approveBtn.classList.add("pulse-animation");
      if (warningText) {
        warningText.innerText = "⚠️ Please Approve VH first";
        warningText.style.color = "#eff107";
      }
    } else {
      spinBtn.disabled = false;
      if (approveBtn) approveBtn.classList.remove("pulse-animation");
      if (warningText) {
        warningText.innerText = "✅ Ready to Summon!";
        warningText.style.color = "#4ade80";
      }
    }
  } catch (e) {
    console.error("Validation Error:", e);
  }
}

// ฟังก์ชันส่งธุรกรรมขออนุญาต (Approve) ให้สัญญาใช้เหรียญ VH ของเราได้
async function approveToken() {
  if (!tokenContract) return;
  if (!(await checkNetwork())) return;

  try {
    showLoader("Requesting Approval...");

    const tx = await tokenContract.approve(
      gachaAddress,
      ethers.utils.parseUnits("1000000000", 8),
    );

    showLoader("Confirming on Blockchain...");
    await tx.wait();
    hideLoader();
    await updateBalance();
    Swal.fire({
      icon: "success",
      title: "Approved!",
      text: "You can now summon your cards.",
      background: "#222",
      color: "#fff",
    });
  } catch (err) {
    hideLoader();
    Swal.fire({
      icon: "error",
      title: "Approval Failed",
      text: getFriendlyMessage(err),
      background: "#222",
      color: "#fff",
    });
  }
}

// ฟังก์ชันสั่งรันการสุ่มการ์ดจาก Smart Contract
async function spinGacha() {
  if (!gachaContract) return connectWallet();
  if (!(await checkNetwork())) return;

  try {
    showLoader("Waiting for Summon Confirmation...");
    // เริ่มเล่นเสียงตอนลุ้นสุ่ม
    sounds.spinning.stop();
    sounds.spinning.play();

    const tx = await gachaContract.spinGacha({ gasLimit: 300000 });

    showLoader("Summoning your Card from the Rift...");
    await tx.wait();
    hideLoader();
    await updateBalance();
    await showGachaReveal();
  } catch (err) {
    hideLoader();
    sounds.spinning.stop();

    Swal.fire({
      icon: "error",
      title: "Summon Failed",
      text: getFriendlyMessage(err),
      background: "#222",
      color: "#fff",
    });
  }
}

// ฟังก์ชันดึงข้อมูลการ์ดทั้งหมดที่ผู้ใช้ถือครองอยู่มาจากบล็อกเชน
async function loadMyCards() {
  if (!gachaContract) return;
  const list = document.getElementById("cardList");
  if (allMyCards.length === 0 && list)
    list.innerHTML =
      '<div style="color:#EFF107; font-family: monospace;">Loading data...</div>';

  try {
    const cards = await gachaContract.getMyCards();
    allMyCards = [...cards].reverse();
    updateCollectionProgress(allMyCards);
    updateQuickSummary(allMyCards);
    handleFilterAndSort();

    renderInventoryChart(allMyCards);
  } catch (err) {
    console.error(err);
    if (list) list.innerHTML = "<p style='color:red'>Error loading cards.</p>";
  }
}

// ฟังก์ชันสั่ง ล็อค/ปลดล็อค การ์ด (เพื่อป้องกันการเผา)
async function toggleLockCard(id) {
  if (!gachaContract) return;
  try {
    showLoader("Updating Lock Status...");
    const tx = await gachaContract.toggleLock(id);
    await tx.wait();
    hideLoader();

    loadMyCards();

    const Toast = Swal.mixin({
      toast: true,
      position: "top-end",
      showConfirmButton: false,
      timer: 2000,
      background: "#222",
      color: "#fff",
    });
    Toast.fire({ icon: "success", title: "Status Updated" });
  } catch (err) {
    hideLoader();
    console.error(err);
    Swal.fire({
      icon: "error",
      title: "Update Failed",
      text: getFriendlyMessage(err),
      background: "#222",
      color: "#fff",
    });
  }
}

// ฟังก์ชันสั่ง ล็อค/ปลดล็อค การ์ดหลายใบพร้อมกันในครั้งเดียว
async function executeBatchLock(cardIds) {
  if (!gachaContract) return;
  try {
    showLoader("Processing Batch Lock...");
    const tx = await gachaContract.batchToggleLock(cardIds);
    await tx.wait();
    hideLoader();
    loadMyCards();
    Swal.fire({
      icon: "success",
      title: "Batch Update Success!",
      background: "#222",
      color: "#fff",
    });
  } catch (err) {
    hideLoader();
    console.error(err);
    Swal.fire({
      icon: "error",
      title: "Batch Failed",
      text: getFriendlyMessage(err),
      background: "#222",
      color: "#fff",
    });
  }
}

// ฟังก์ชันสั่งทำลายการ์ดทิ้งเพื่อรับเหรียญคืน
async function executeBurn() {
  if (!gachaContract || !cardToBurn) return;

  const tokenIdToBurn = cardToBurn;
  closeBurnModal();

  try {
    showLoader("Burning Card...");

    const tx = await gachaContract.burnCard(tokenIdToBurn);
    await tx.wait();

    hideLoader();

    addHistory(
      "BURN",
      `Destroyed Card #${tokenIdToBurn.substring(0, 6)} (Refunded Tokens)`,
    );

    await updateBalance();
    await loadMyCards();

    Swal.fire({
      title: "🔥 BURNED!",
      text: "Card destroyed. You received tokens back!",
      icon: "success",
      background: "#222",
      color: "#fff",
      confirmButtonColor: "#ef4444",
    });
  } catch (err) {
    hideLoader();
    console.error(err);
    Swal.fire({
      icon: "error",
      title: "Burn Failed",
      text: getFriendlyMessage(err),
      background: "#222",
      color: "#fff",
    });
  }
}

// ฟังก์ชันสุ่มใหม่อีกครั้ง
function spinAgain() {
  document.getElementById("gachaRevealOverlay").style.display = "none";
  sounds.congrat.stop();
  spinGacha();
}

if (window.ethereum) {
  window.ethereum.on("accountsChanged", () => window.location.reload());
  window.ethereum.on("chainChanged", () => window.location.reload());
}

// ฟังก์ชันจุดพลุกระดาษฉลองเมื่อสุ่มได้การ์ดระดับสูง
function playLegendConfetti() {
  var duration = 3000; // ยิงพลุนาน 3 วินาที
  var end = Date.now() + duration;

  (function frame() {
    // ยิงจากซ้าย
    confetti({
      particleCount: 5,
      angle: 60,
      spread: 55,
      origin: { x: 0 },
      colors: ["#eff107", "#fbbf24", "#ffffff"], // เหลือง, ทอง, ขาว
      zIndex: 9999,
    });
    // ยิงจากขวา
    confetti({
      particleCount: 5,
      angle: 120,
      spread: 55,
      origin: { x: 1 },
      colors: ["#eff107", "#fbbf24", "#ffffff"],
      zIndex: 9999,
    });

    if (Date.now() < end) {
      requestAnimationFrame(frame);
    }
  })();
}

// ฟังก์ชันสร้างข้อความแนะนำ (Hint) เมื่อเอาเมาส์ไปชี้ที่ปุ่มต่างๆ
function initTooltips() {
  tippy("[title]", {
    content(reference) {
      const title = reference.getAttribute("title");
      reference.removeAttribute("title");
      return title;
    },
    animation: "scale",
    theme: "translucent",
    placement: "top",
    delay: [100, 0],
  });
}

initTooltips();

// ==========================================
// [เพิ่มใหม่] ฟังก์ชันการทำงานของ Auto Battler (Pokemon Style)
// ==========================================

// ฟังก์ชันหน่วงเวลา (ทำให้ข้อความค่อยๆ ขึ้นทีละบรรทัด)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ฟังก์ชันคำนวณค่าพลังจากการ์ด
function getCardPower(rarity, id) {
  const idNum = Number(BigInt(id) % 100n);
  if (rarity === "Legend") return 150 + Math.floor((idNum / 100) * 50); // 150-199
  if (rarity === "Rare") return 80 + Math.floor((idNum / 100) * 40); // 80-119
  return 30 + Math.floor((idNum / 100) * 30); // 30-59
}

// เลือก/ถอด การ์ดเข้า Deck
function toggleBattleCard(cardId) {
  const index = battleDeck.indexOf(cardId);
  if (index > -1) {
    battleDeck.splice(index, 1);
    Swal.fire({
      toast: true,
      position: "top-end",
      timer: 1500,
      showConfirmButton: false,
      background: "#222",
      color: "#fff",
      icon: "info",
      title: "Removed from Deck",
    });
  } else {
    if (battleDeck.length >= 3) {
      Swal.fire({
        icon: "warning",
        title: "Deck Full",
        text: "จัดทีมได้สูงสุด 3 ใบเท่านั้น!",
        background: "#222",
        color: "#fff",
      });
      return;
    }
    battleDeck.push(cardId);
    Swal.fire({
      toast: true,
      position: "top-end",
      timer: 1500,
      showConfirmButton: false,
      background: "#222",
      color: "#fff",
      icon: "success",
      title: `Added to Deck (${battleDeck.length}/3)`,
    });
  }
  updateBattleUI();
}

// อัปเดตหน้าตา UI และรีเซ็ตหลอดเลือดให้เต็มทุกครั้งที่จัดทีมใหม่
function updateBattleUI() {
  const container = document.getElementById("selectedCardsForBattle");
  const powerDisplay = document.getElementById("playerTotalPower");

  // รีเซ็ตหลอดเลือดและพลังบอสกลับมาเต็ม 100%
  document.querySelector(".hp-boss").style.width = "100%";
  document.querySelector(".hp-player").style.width = "100%";
  document.getElementById("bossTotalPower").innerText = "???";
  document.getElementById("battleLog").innerHTML =
    "What will YOUR DECK do?<br>Waiting for Challenger...";

  if (!container) return;

  if (battleDeck.length === 0) {
    container.innerHTML =
      '<div class="empty-state"><p>ยังไม่ได้จัดทีม</p></div>';
    powerDisplay.innerText = "0";
    return;
  }

  container.innerHTML = "";
  let totalPower = 0;

  battleDeck.forEach((id) => {
    const card = allMyCards.find((c) => c.id.toString() === id.toString());
    if (card) {
      totalPower += getCardPower(card.rarity, id);

      // นำรูปการ์ดมาเรียงซ้อนกันแบบมินิ
      let imgPath = "";
      const idForImage = BigInt(id);
      if (card.rarity === "Legend")
        imgPath = `images/legendary/Legend_${Number(idForImage % 4n)}.png`;
      else if (card.rarity === "Rare")
        imgPath = `images/rare/Rare_${Number(idForImage % 6n)}.png`;
      else imgPath = `images/common/Common_${Number(idForImage % 10n)}.png`;

      container.innerHTML += `
                <img src="${imgPath}" onerror="this.src='images/default.png'" style="height: 80px; border-radius: 4px; border: 2px solid white; margin-left: -20px; box-shadow: -2px 0 5px rgba(0,0,0,0.5); background:#111;">
            `;
    }
  });

  powerDisplay.innerText = totalPower;
}

// ปุ่มหนี (RUN)
function closeBattle() {
  const log = document.getElementById("battleLog");
  log.innerHTML = "Got away safely!";

  setTimeout(() => {
    // เด้งกลับไปหน้า Inventory
    switchTab("inventory");
    // รีเซ็ตคำทักทายตอนกลับมาใหม่
    updateBattleUI();
  }, 800);
}

// เริ่มต่อสู้ (Turn-based Sequence)
async function startBattle() {
  document.querySelector(".hp-boss").style.width = "100%";
  document.querySelector(".hp-player").style.width = "100%";

  if (battleDeck.length !== 3) {
    Swal.fire({
      icon: "warning",
      title: "Wait!",
      text: "กรุณาจัดทีมให้ครบ 3 ใบก่อน",
      background: "#222",
      color: "#fff",
    });
    return;
  }

  // ปิดปุ่มกดชั่วคราวกันกดรัว
  const fightBtn = document.querySelector(".btn-poke-fight");
  const runBtn = document.querySelector(".btn-poke-run");
  fightBtn.disabled = true;
  runBtn.disabled = true;

  const log = document.getElementById("battleLog");
  const bossHpBar = document.querySelector(".hp-boss");
  const playerHpBar = document.querySelector(".hp-player");
  const bossAvatar = document.querySelector(".boss-avatar");

  // 1. คำนวณพลัง
  let playerPower = parseInt(
    document.getElementById("playerTotalPower").innerText,
  );
  let bossPower = Math.floor(Math.random() * 150) + (playerPower - 30);
  if (bossPower < 100) bossPower = 100;

  // ฉากเปิด
  document.getElementById("bossTotalPower").innerText = bossPower;
  log.innerHTML = `Wild AI BOSS appeared!<br>It has ${bossPower} PWR!`;
  await delay(2000);

  // เทิร์นผู้เล่นโจมตี
  log.innerHTML = `YOUR DECK used ATTACK!<br>Dealing ${playerPower} damage!`;

  // ทำให้บอสกระตุกและกะพริบแดง
  bossAvatar.classList.add("taking-damage");
  setTimeout(() => bossAvatar.classList.remove("taking-damage"), 400);

  // ลดหลอดเลือดบอสแบบลื่นๆ
  let bossRemainingHp = 100 - (playerPower / bossPower) * 100;
  bossRemainingHp = Math.max(0, bossRemainingHp); // ห้ามติดลบ
  bossHpBar.style.width = `${bossRemainingHp}%`;

  await delay(2000);

  // 2. ตัดสินผล
  if (playerPower >= bossPower) {
    // ผู้เล่นชนะ
    log.innerHTML = `AI BOSS fainted!<br>You gained 50 VH!`;
    await delay(1500);
    await generateSignatureAndClaim();
  } else {
    // บอสโจมตีสวนกลับ (ผู้เล่นแพ้)
    log.innerHTML = `AI BOSS attacks back!<br>It's super effective!`;

    // ลดหลอดเลือดผู้เล่น
    let playerRemainingHp = 100 - (bossPower / playerPower) * 100;
    playerRemainingHp = Math.max(0, playerRemainingHp);
    playerHpBar.style.width = `${playerRemainingHp}%`;

    await delay(2000);
    log.innerHTML = `YOUR DECK fainted!<br>You blacked out...`;
  }

  // เปิดปุ่มให้กดใหม่ได้
  fightBtn.disabled = false;
  runBtn.disabled = false;
}

// สร้าง Signature และเรียกเคลมรางวัล
// แก้ไขฟังก์ชันใน script.js เป็นแบบนี้
async function generateSignatureAndClaim() {
  try {
    const rewardAmount = ethers.utils.parseUnits("50", 8);
    const nonce = Math.floor(Math.random() * 1000000000);

    document.getElementById("battleLog").innerHTML = `Requesting Signature...`;

    // 1. ขอ Signature จาก Backend (Vercel API) ของเราเอง
    const response = await fetch("/api/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userAddress: userAddress,
        rewardAmount: rewardAmount.toString(),
        nonce: nonce,
      }),
    });

    if (!response.ok) throw new Error("Failed to get signature from server");

    const data = await response.json();
    const signature = data.signature; // ได้รับ Signature มาอย่างปลอดภัย

    // 2. ส่งไปเคลมที่ Smart Contract
    document.getElementById("battleLog").innerHTML =
      `Claiming Reward...<br>Please confirm in MetaMask.`;

    const tx = await gachaContract.claimBattleReward(
      rewardAmount,
      nonce,
      signature,
    );

    document.getElementById("battleLog").innerHTML =
      `Waiting for Blockchain...`;
    await tx.wait();

    document.getElementById("battleLog").innerHTML =
      `<span style="color: #4ade80;">Got reward!</span>`;
  } catch (err) {
    console.error(err);
    document.getElementById("battleLog").innerHTML =
      `<span style="color: #ef4444;">Error claiming reward</span>`;
  }
}
