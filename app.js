/* =========================================================
   REURB - Envio de documentos
   Google Drive + XLSX + Gmail
   ========================================================= */

const CONFIG = {
  CLIENT_ID: "298689728813-n1pa123cvd9gub3ui63trnom57hm5amg.apps.googleusercontent.com",

  // Pasta raiz A.S_AGRIMENSOR informada pelo usuário.
  ROOT_FOLDER_ID: "1-I_fkHUYOCUaY_J4TS2TV3q1SBSeFAgu",

  // Nome da pasta que contém os processos.
  LEVANTAMENTOS_FOLDER_NAME: "1.LEVANTAMENTOS_TOPOGRÁFICOS",
  MAX_RECENT_PROCESSES: Number(localStorage.getItem("reurb_process_limit") || 10),
  PROCESS_LIMIT_OPTIONS: [10, 20, 30, 50, 100],
  ENABLE_SERVICE_WORKER: false,
  APP_VERSION: "16.0.0",

  DEST_EMAIL_KEY: "reurb_dest_email",
  TOKEN_KEY: "reurb_google_token",
  SENT_CLIENT_KEY: "reurb_sent_client",
  SENT_PREFEITURA_KEY: "reurb_sent_prefeitura"
};

// Para a primeira versão usamos somente leitura do Drive.
// Não cria compartilhamentos nem altera arquivos.
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive"
].join(" ");
const DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";

let tokenClient = null;
let googleReady = false;
let driveReady = false;
let accessToken = null;
let levantamentoFolder = null;
let processes = [];
let currentProcess = null;

// Controle local dos envios. Cada tipo é armazenado separadamente para que
// um processo REURB possa ter, por exemplo, Cliente enviado e Prefeitura pendente.
const sentState = { cliente: {}, prefeitura: {} };

function loadSentProcesses() {
  for (const type of ["cliente", "prefeitura"]) {
    const key = type === "cliente" ? CONFIG.SENT_CLIENT_KEY : CONFIG.SENT_PREFEITURA_KEY;
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      sentState[type] = parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      console.warn("Não foi possível carregar o status de envio:", type, err);
      sentState[type] = {};
    }
  }
}

function isProcessSent(processNumber, type) {
  if (!processNumber || !sentState[type]) return false;
  return sentState[type][String(processNumber)] === true;
}

function markProcessSent(processNumber, type) {
  if (!processNumber || !sentState[type]) return;
  const key = String(processNumber);
  sentState[type][key] = true;
  const storageKey = type === "cliente" ? CONFIG.SENT_CLIENT_KEY : CONFIG.SENT_PREFEITURA_KEY;
  localStorage.setItem(storageKey, JSON.stringify(sentState[type]));
}

function getGreeting(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 6 && hour < 12) return "Olá, bom dia";
  if (hour >= 12 && hour < 18) return "Olá, boa tarde";
  return "Olá, boa noite";
}

function driveViewLink(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  // Service Worker desativado durante o desenvolvimento para evitar cache antigo.
  // Será reativado quando a versão PWA estiver estável.
  loadSavedSettings();
  loadSentProcesses();
  showScreen("setup");

  // O Google Identity Services carrega de forma assíncrona.
  waitForGoogle();
});

function bindEvents() {
  $("btn-save-setup").addEventListener("click", saveSetup);
  $("btn-login").addEventListener("click", loginGoogle);
  $("btn-open-settings-from-login").addEventListener("click", () => showScreen("setup"));
  $("btn-settings").addEventListener("click", () => showScreen("setup"));
  $("btn-refresh").addEventListener("click", loadProcesses);
  $("btn-back-to-list").addEventListener("click", () => showScreen("list"));

  $("input-search").addEventListener("input", renderProcessList);
  if ($("process-limit")) {
    $("process-limit").addEventListener("change", () => {
      const value = Number($("process-limit").value) || 10;
      localStorage.setItem("reurb_process_limit", String(value));
      CONFIG.MAX_RECENT_PROCESSES = value;
      loadProcesses();
    });
  }
}

function loadSavedSettings() {
  $("input-dest-email").value = localStorage.getItem(CONFIG.DEST_EMAIL_KEY) || "";
  if ($("process-limit")) {
    const saved = Number(localStorage.getItem("reurb_process_limit") || 10);
    $("process-limit").value = CONFIG.PROCESS_LIMIT_OPTIONS.includes(saved) ? String(saved) : "10";
    CONFIG.MAX_RECENT_PROCESSES = Number($("process-limit").value);
  }
}

function saveSetup() {
  const email = $("input-dest-email").value.trim();

  if (!email || !isValidEmail(email)) {
    showToast("Informe um e-mail de destino válido.");
    $("input-dest-email").focus();
    return;
  }

  localStorage.setItem(CONFIG.DEST_EMAIL_KEY, email);

  if (accessToken) {
    showScreen("list");
    loadProcesses();
  } else {
    showScreen("login");
  }
}

let googleInitPromise = null;

function waitForGoogle() {
  const started = Date.now();

  const attempt = async () => {
    if (window.google?.accounts?.oauth2 && window.gapi) {
      googleReady = true;
      try {
        await initGoogleClient();
        return;
      } catch (err) {
        console.error("Falha ao inicializar Google:", err);
      }
    }

    if (Date.now() - started < 60000) {
      setTimeout(attempt, 250);
    } else {
      showLoginError("O Google não terminou de carregar. Verifique sua internet e atualize a página.");
    }
  };

  attempt();
}

async function initGoogleClient() {
  if (driveReady && tokenClient) return;
  if (googleInitPromise) return googleInitPromise;

  googleInitPromise = (async () => {
    if (!window.gapi || !window.google?.accounts?.oauth2) {
      throw new Error("Bibliotecas do Google ainda não carregadas.");
    }

    await new Promise((resolve, reject) => {
      try {
        gapi.load("client", resolve);
      } catch (e) {
        reject(e);
      }
    });

    await gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] });

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: GOOGLE_SCOPES,
      callback: (response) => {
        if (response.error) {
          handleError(response.error_description || response.error);
          return;
        }

        accessToken = response.access_token;
        gapi.client.setToken({ access_token: accessToken });
        localStorage.setItem(CONFIG.TOKEN_KEY, accessToken);
        setOnline(true);
        loadProcesses();
      }
    });

    driveReady = true;
    googleReady = true;
    console.log("Google Drive pronto para autenticação.");
  })();

  try {
    await googleInitPromise;
  } finally {
    googleInitPromise = null;
  }
}

async function loginGoogle() {
  try {
    if (!tokenClient || !driveReady) {
      showLoginError("Inicializando o Google...");
      await initGoogleClient();
    }

    if (!tokenClient || !driveReady) {
      throw new Error("O Google ainda não está pronto.");
    }

    tokenClient.requestAccessToken({ prompt: "consent" });

  } catch (err) {
    console.error(err);
    showLoginError("Não foi possível inicializar o Google. Atualize a página e tente novamente.");
  }
}

async function loadProcesses() {
  if (!accessToken) {
    showScreen("login");
    return;
  }

  showScreen("list");
  $("list-container").innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      Localizando os últimos ${CONFIG.MAX_RECENT_PROCESSES} processos...
    </div>`;

  $("list-banner").innerHTML = "";

  try {
    levantamentoFolder = await findChildFolderByNormalizedName(
      CONFIG.ROOT_FOLDER_ID,
      CONFIG.LEVANTAMENTOS_FOLDER_NAME
    );

    if (!levantamentoFolder) {
      throw new Error(
        `A pasta "${CONFIG.LEVANTAMENTOS_FOLDER_NAME}" não foi encontrada dentro de A.S_AGRIMENSOR.`
      );
    }

    $("folder-breadcrumb").textContent =
      `A.S_AGRIMENSOR / ${levantamentoFolder.name}`;

    // IMPORTANTE: não carregamos todas as pastas.
    // Como o nome começa pela data do processo (AAAAMMDD),
    // ordenar por nome em ordem decrescente nos dá os processos mais recentes.
    const processFolders = await listRecentProcessFolders(
      levantamentoFolder.id,
      CONFIG.MAX_RECENT_PROCESSES
    );

    $("list-container").innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        Lendo ${processFolders.length} processo(s) mais recente(s)...
      </div>`;

    const results = [];

    // No máximo 5 processos são lidos simultaneamente.
    for (let i = 0; i < processFolders.length; i += 5) {
      const batch = processFolders.slice(i, i + 5);

      const batchResults = await Promise.all(
        batch.map(async folder => {
          try {
            return await loadProcessSummary(folder);
          } catch (err) {
            console.warn("Falha no processo:", folder.name, err);
            return {
              folder,
              data: null,
              error: err.message || "Erro ao ler o processo."
            };
          }
        })
      );

      results.push(...batchResults);
    }

    processes = results
      .filter(x => x.data || !x.error)
      .sort((a, b) => {
        const pa = a.data?.projeto_numero || a.folder.name;
        const pb = b.data?.projeto_numero || b.folder.name;
        return pb.localeCompare(pa, "pt-BR", { numeric: true });
      });

    renderProcessList();

    $("list-banner").innerHTML = `
      <div class="small-note" style="margin:0 0 12px 0; padding:10px 12px; border:1px solid var(--border); border-radius:11px; background:white;">
        V14: mostrando ${processes.length} processo(s) dos ${CONFIG.MAX_RECENT_PROCESSES} solicitados. Os demais processos não são carregados nem processados.
      </div>`;

    if (!processes.length) {
      $("list-container").innerHTML = `
        <div class="empty">
          Nenhuma pasta de processo foi encontrada.
        </div>`;
    }
  } catch (err) {
    console.error(err);
    $("list-container").innerHTML = `
      <div class="error-box">
        ${escapeHtml(err.message || "Erro ao carregar os processos.")}
      </div>`;
    setOnline(false);
  }
}

async function listRecentProcessFolders(parentId, limit) {
  // Consulta somente a quantidade escolhida pelo usuário.
  // Não fazemos paginação: os demais processos não são carregados.
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);

  const response = await gapi.client.drive.files.list({
    q: `'${escapeDriveQuery(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    pageSize: safeLimit,
    orderBy: "name desc",
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)"
  });

  const files = response.result.files || [];
  return files.slice(0, safeLimit);
}

async function loadProcessSummary(folder) {
  const children = await listChildren(folder.id);
  const xlsx = children.find(
    f => f.name.toLowerCase() === "cliente_serviço consulta.xlsx".toLowerCase()
  ) || children.find(
    f => f.name.toLowerCase().includes("cliente") && f.name.toLowerCase().endsWith(".xlsx")
  );

  let data = null;

  if (xlsx) {
    data = await readXlsxFromDrive(xlsx.id);
  }

  return {
    folder,
    data,
    xlsx,
    children
  };
}

async function openProcess(processItem) {
  currentProcess = processItem;
  showScreen("detail");

  $("detail-container").innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      Carregando detalhes do processo...
    </div>`;

  try {
    const children = await listChildren(processItem.folder.id);

    const data = processItem.data || {};
    const structure = await inspectProcessStructure(children, processItem.data || {}, processItem.folder.name);

    currentProcess = {
      ...processItem,
      children,
      data,
      structure
    };

    renderProcessDetail(currentProcess);
  } catch (err) {
    console.error(err);
    $("detail-container").innerHTML = `
      <div class="error-box">${escapeHtml(err.message || "Erro ao abrir o processo.")}</div>`;
  }
}

async function inspectProcessStructure(children, data = {}, folderName = "") {
  const result = {
    cadFolder: null,
    documentsFolder: null,
    complementaryFolder: null,
    cadFile: null,
    rawDataFolder: null,
    stationFolder: null,
    rawPlanFile: null,
    expectedPlanName: "",
    declaration: null,
    expectedDwgName: "",
    memorial: null,
    plantaTopografica: null,
    plantaLocalizacao: null,
    trt: null,
    requerimento: null,
    fichaIdentificacao: null,
    trfu: null
  };

  result.cadFolder = children.find(
    f => f.mimeType === "application/vnd.google-apps.folder" &&
         normalize(f.name) === normalize("2.PROJETO_CAD")
  );

  result.documentsFolder = children.find(
    f => f.mimeType === "application/vnd.google-apps.folder" &&
         normalize(f.name) === normalize("3.DOCUMENTOS")
  );

  if (result.cadFolder) {
    const cadChildren = await listChildren(result.cadFolder.id);

    // O DWG segue o padrão: NUMERO_DO_PROCESSO_CAD.dwg
    // Ex.: 20260718-127_CAD.dwg
    const processNumber =
      String(data?.projeto_numero || extractProcessNumber(folderName) || "")
        .trim();

    const expectedDwgName = processNumber ? `${processNumber}_CAD.dwg` : "";
    result.expectedDwgName = expectedDwgName;

    // Primeiro tenta o nome exato esperado.
    result.cadFile = cadChildren.find(f =>
      expectedDwgName && normalizeFileName(f.name) === normalizeFileName(expectedDwgName)
    ) || null;

    // Se não encontrar pelo nome, aceita qualquer DWG diretamente dentro de 2.PROJETO_CAD.
    // Isso cobre pequenas diferenças de maiúsculas/minúsculas ou nomenclatura.
    if (!result.cadFile) {
      result.cadFile = cadChildren.find(f => /\.dwg$/i.test(f.name)) || null;
    }
  }

  // Dados brutos: 1.DADOS_BRUTOS / ESTAÇÃO_TOTAL / NUMERO_DO_PROCESSO_PLAN.ptf
  result.rawDataFolder = children.find(
    f => f.mimeType === "application/vnd.google-apps.folder" &&
         normalize(f.name) === normalize("1.DADOS_BRUTOS")
  );

  if (result.rawDataFolder) {
    const rawChildren = await listChildren(result.rawDataFolder.id);
    result.stationFolder = rawChildren.find(
      f => f.mimeType === "application/vnd.google-apps.folder" &&
           normalize(f.name) === normalize("ESTAÇÃO_TOTAL")
    );

    if (result.stationFolder) {
      const stationChildren = await listChildren(result.stationFolder.id);
      const processNumber = String(data?.projeto_numero || extractProcessNumber(folderName) || "").trim();
      const expectedPlanName = processNumber ? `${processNumber}_PLAN.ptf` : "";
      result.expectedPlanName = expectedPlanName;
      result.rawPlanFile = stationChildren.find(f =>
        expectedPlanName && normalizeFileName(f.name) === normalizeFileName(expectedPlanName)
      ) || stationChildren.find(f => /\.ptf$/i.test(f.name)) || null;
    }
  }

  if (result.documentsFolder) {
    const docs = await listChildren(result.documentsFolder.id);

    result.declaration = findFileByNormalizedName(docs, "1.DECLARAÇÃO_TÉCNICO-PROPRIETÁRIO.pdf");
    result.memorial = findFileByNormalizedName(docs, "2.MEMORIAL_DESCRITIVO.pdf");
    result.plantaTopografica = findFileByNormalizedName(docs, "3.1.PLANTA_TOPOGRÁFICA.pdf");

    // Aceita também o nome antigo com "PLATAN", caso algum processo use essa grafia.
    result.plantaLocalizacao = findFileByNormalizedName(docs, "3.2.PLANTA_LOCALIZAÇÃO.pdf") ||
      docs.find(f => /^3\.2\.platan[_ ]localizacao/i.test(f.name)) || null;

    // O número do TRT vem da planilha. O arquivo começa com 4.TRT e pode ter extensão variável.
    const trtNumber = String(data?.trt || "").trim();
    result.trt = docs.find(f => {
      const n = normalize(f.name);
      return n.startsWith(normalize("4.TRT")) &&
        (!trtNumber || n.includes(normalize(trtNumber)));
    }) || docs.find(f => normalize(f.name).startsWith(normalize("4.TRT"))) || null;

    result.requerimento = findFileByNormalizedName(docs, "5.REQUERIMENTO_REURB.pdf");
    result.fichaIdentificacao = findFileByNormalizedName(docs, "6.FICHA_IDENTIFICAÇÃO_OCUPANTE-IMÓVEL.pdf");

    result.complementaryFolder = docs.find(
      f => f.mimeType === "application/vnd.google-apps.folder" &&
           (normalize(f.name) === normalize("COMPLEMENTAR") ||
            normalize(f.name) === normalize("3.1.COMPLEMENTARES"))
    ) || null;

    if (result.complementaryFolder) {
      const compFiles = await listChildren(result.complementaryFolder.id);
      result.trfu = compFiles.find(
        f => normalize(f.name).startsWith(normalize("Comp_TRFU")) &&
             /\.(pdf|jpe?g|png)$/i.test(f.name)
      ) || null;
    }
  }

  return result;
}

function findFileByNormalizedName(files, expectedName) {
  const expected = normalize(expectedName);
  return files.find(f => normalize(f.name) === expected) || null;
}

function itemProcessNumber(item) {
  return item?.data?.projeto_numero || extractProcessNumber(item?.folder?.name) || "";
}

function normalizeFileName(value) {
  return normalize(value).replace(/\s+/g, "");
}

function getPrefeituraDocumentEntries(item) {
  const s = item.structure || {};
  return [
    { icon: "📐", label: "Arquivo CAD", emailLabel: "📐 Arquivo CAD", file: s.cadFile },
    { icon: "📄", label: "Memorial Descritivo", emailLabel: "📄 Memorial Descritivo", file: s.memorial },
    { icon: "🗺️", label: "Planta Topográfica", emailLabel: "🗺️ Planta Topográfica", file: s.plantaTopografica },
    { icon: "📍", label: "Planta de Localização", emailLabel: "📍 Planta de Localização", file: s.plantaLocalizacao },
    { icon: "🧾", label: `TRT${item.data?.trt ? " — " + item.data.trt : ""}`, emailLabel: `🧾 TRT${item.data?.trt ? " — " + item.data.trt : ""}`, file: s.trt },
    { icon: "📝", label: "Requerimento REURB", emailLabel: "📝 Requerimento REURB", file: s.requerimento },
    { icon: "👤", label: "Ficha Identificação Ocupante-Imóvel", emailLabel: "👤 Ficha Identificação Ocupante-Imóvel", file: s.fichaIdentificacao },
    { icon: "💳", label: "Comprovante TRFU", emailLabel: "💳 Comprovante TRFU", file: s.trfu }
  ];
}

function getClientDocumentEntries(item) {
  const s = item.structure || {};
  return [
    { icon: "📊", label: "Dados brutos — Estação Total", emailLabel: "📊 Dados brutos — Estação Total", file: s.rawPlanFile },
    { icon: "📐", label: "Arquivo CAD", emailLabel: "📐 Arquivo CAD", file: s.cadFile },
    { icon: "📄", label: "Declaração Técnico-Proprietário", emailLabel: "📄 Declaração Técnico-Proprietário", file: s.declaration },
    { icon: "📄", label: "Memorial Descritivo", emailLabel: "📄 Memorial Descritivo", file: s.memorial },
    { icon: "🗺️", label: "Planta Topográfica", emailLabel: "🗺️ Planta Topográfica", file: s.plantaTopografica },
    { icon: "📍", label: "Planta de Localização", emailLabel: "📍 Planta de Localização", file: s.plantaLocalizacao },
    { icon: "🧾", label: `TRT${item.data?.trt ? " — " + item.data.trt : ""}`, emailLabel: `🧾 TRT${item.data?.trt ? " — " + item.data.trt : ""}`, file: s.trt }
  ];
}

function isReurb(item) {
  return normalize(item?.data?.tipo_servico || "") === normalize("REURB");
}

function renderProcessList() {
  const search = normalize($("input-search").value || "");

  const filtered = processes.filter(item => {
    const d = item.data || {};
    const text = normalize([
      d.projeto_numero,
      d.pessoa_nome,
      d.pessoa_cpf,
      d.imovel_endereco_completo,
      item.folder.name
    ].join(" "));
    return !search || text.includes(search);
  });

  if (!filtered.length) {
    $("list-container").innerHTML = `
      <div class="empty">Nenhum processo corresponde à pesquisa.</div>`;
    return;
  }

  $("list-container").innerHTML = `
    <div class="process-list">
      ${filtered.map(item => {
        const d = item.data || {};
        const processNumber = d.projeto_numero || extractProcessNumber(item.folder.name) || "Processo";
        const sentClient = isProcessSent(processNumber, "cliente");
        const sentPrefeitura = isProcessSent(processNumber, "prefeitura");
        const sent = sentClient || sentPrefeitura;
        return `
          <div class="process-card ${sent ? "sent" : ""}">
            <button data-process-index="${processes.indexOf(item)}">
              <div class="process-card-top">
                <div class="process-number">${escapeHtml(processNumber)}</div>
                ${sentClient ? '<span class="sent-badge">✓ Cliente</span>' : '<span class="pending-badge">Cliente pendente</span>'}
                ${isReurb(item) ? (sentPrefeitura ? '<span class="sent-badge">✓ Prefeitura</span>' : '<span class="pending-badge">Prefeitura pendente</span>') : ''}
              </div>
              <div class="process-name">${escapeHtml(d.pessoa_nome || extractNameFromFolder(item.folder.name) || item.folder.name)}</div>
              <div class="process-address">${escapeHtml(d.imovel_endereco_completo || "Dados do imóvel não encontrados na planilha.")}</div>
            </button>
          </div>`;
      }).join("")}
    </div>`;

  $("list-container").querySelectorAll("[data-process-index]").forEach(btn => {
    btn.addEventListener("click", () => {
      openProcess(processes[Number(btn.dataset.processIndex)]);
    });
  });
}

function getDisplayDocumentEntries(item) {
  // A tela mostra todos os documentos relevantes ao processo.
  // Em REURB, inclui também os documentos exclusivos da Prefeitura.
  // Para serviços comuns, mostra somente os documentos do levantamento/cliente.
  const client = getClientDocumentEntries(item);
  if (!isReurb(item)) return client;

  const extraPrefeitura = [
    { icon: "📝", label: "Requerimento REURB", emailLabel: "📝 Requerimento REURB", file: item.structure?.requerimento },
    { icon: "👤", label: "Ficha Identificação Ocupante-Imóvel", emailLabel: "👤 Ficha Identificação Ocupante-Imóvel", file: item.structure?.fichaIdentificacao },
    { icon: "💳", label: "Comprovante TRFU", emailLabel: "💳 Comprovante TRFU", file: item.structure?.trfu }
  ];
  return [...client, ...extraPrefeitura];
}

function renderProcessDetail(item) {
  const d = item.data || {};
  const documents = getDisplayDocumentEntries(item);
  const foundCount = documents.filter(x => x.file).length;
  const missingCount = documents.length - foundCount;
  const tipoServico = item.data?.tipo_servico || "";
  const clientEmail = item.data?.email || "";

  $("detail-container").innerHTML = `
    <div class="detail-grid">
      <div class="detail-card">
        <div class="detail-label">Processo</div>
        <div class="detail-value"><strong>${escapeHtml(d.projeto_numero || extractProcessNumber(item.folder.name) || "-")}</strong></div>
      </div>

      <div class="detail-card">
        <div class="detail-label">Cliente</div>
        <div class="detail-value"><strong>${escapeHtml(d.pessoa_nome || extractNameFromFolder(item.folder.name) || "-")}</strong></div>
      </div>

      <div class="detail-card">
        <div class="detail-label">CPF e TRT</div>
        <div class="detail-value"><strong>CPF:</strong> ${escapeHtml(d.pessoa_cpf || d["CPF mascara"] || "-")}<br><strong>TRT:</strong> ${escapeHtml(d.trt || "-")}</div>
      </div>

      <div class="detail-card">
        <div class="detail-label">Endereço do imóvel</div>
        <div class="detail-value">${escapeHtml(d.imovel_endereco_completo || "-")}</div>
      </div>

      <div class="detail-card wide">
        <div class="detail-label">Documentos encontrados no processo</div>
        <div class="small-note" style="margin-top:0;padding-top:0;border-top:0">
          A lista abaixo mostra os documentos existentes no processo. A indicação "Encontrado" não significa que o arquivo será enviado para todos os destinatários.
        </div>
        <div class="doc-list">
          ${documents.map(({icon, label, file}) => `
            <div class="doc-row">
              <div>
                <div class="doc-name">${escapeHtml(icon + " " + label)}</div>
                ${file ? `<div class="doc-file-name">${escapeHtml(file.name)}</div>` : (label === "Arquivo CAD" && item.structure?.expectedDwgName ? `<div class="doc-file-name">Esperado: ${escapeHtml(item.structure.expectedDwgName)}</div>` : "")}
              </div>
              <span class="${file ? "ok" : "missing"}">${file ? "✓ Encontrado" : "✕ Não encontrado"}</span>
            </div>
          `).join("")}
        </div>
        ${missingCount ? `
          <div class="warning-box">
            ${missingCount} documento(s) esperado(s) não foi/foram encontrado(s).
          </div>` : `
          <div class="success-box">
            Todos os documentos previstos para esta modalidade foram encontrados.
          </div>`}
      </div>

      <div class="detail-card wide">
        <div class="detail-label">Tipo de serviço</div>
        <div class="detail-value"><strong>${escapeHtml(tipoServico || "Não informado")}</strong></div>
        <div class="detail-label" style="margin-top:14px">E-mail do cliente</div>
        <div class="detail-value">${escapeHtml(clientEmail || "Não informado")}</div>
      </div>

      <div class="detail-card wide">
        <div class="detail-label">Envio para o cliente</div>
        <div class="small-note" style="margin-top:0;padding-top:0;border-top:0">
          Inclui dados brutos da estação total, declaração técnico-proprietário e os demais documentos do levantamento.
        </div>
        <div class="actions">
          <button class="primary" id="btn-compose-client">👤 Enviar e-mail para cliente</button>
        </div>
        <div class="small-note">Status: ${isProcessSent(itemProcessNumber(item), "cliente") ? "✓ Cliente já enviado" : "Pendente"}</div>
      </div>

      <div class="detail-card wide">
        <div class="detail-label">Envio para a prefeitura</div>
        <div class="small-note" style="margin-top:0;padding-top:0;border-top:0">Disponível somente quando o tipo de serviço for REURB.</div>
        <div class="actions">
          <button class="primary" id="btn-compose-prefeitura" ${isReurb(item) ? "" : "disabled"}>🏛️ Enviar e-mail para prefeitura</button>
        </div>
        <div class="small-note">Status: ${isProcessSent(itemProcessNumber(item), "prefeitura") ? "✓ Prefeitura já enviada" : (isReurb(item) ? "Pendente" : "Não aplicável")}</div>
      </div>

      <div class="detail-card wide">
        <div class="detail-label">Links individuais dos documentos encontrados</div>
        <div class="link-list">
          ${documents.filter(x => x.file).map(({icon, label, file}) => `
            <a class="file-link" title="Abrir documento no Google Drive" href="${escapeHtml(file.webViewLink || driveViewLink(file.id))}" target="_blank" rel="noopener">
              <span>${escapeHtml(icon + " " + label)}</span><span>↗</span>
            </a>
          `).join("") || '<div class="empty">Nenhum arquivo encontrado.</div>'}
        </div>
        <div class="small-note">Cada documento possui seu próprio link no Google Drive. A pasta do processo não é compartilhada.</div>
        <div id="detail-message"></div>
      </div>
    </div>`;

  $("btn-compose-client").addEventListener("click", () => {
    prepareClientEmail(item);
  });
  $("btn-compose-prefeitura").addEventListener("click", () => {
    if (isReurb(item)) preparePrefeituraEmail(item);
  });
}

async function prepareClientEmail(item) {
  const destination = String(item.data?.email || "").trim();
  if (!isValidEmail(destination)) {
    showToast("O campo EMAIL da planilha não contém um e-mail válido.");
    return;
  }
  return prepareEmailByType(item, "cliente", destination, getClientDocumentEntries(item));
}

async function preparePrefeituraEmail(item) {
  if (!isReurb(item)) return;
  const destination = localStorage.getItem(CONFIG.DEST_EMAIL_KEY) || "";
  if (!destination) {
    showToast("Configure o e-mail fixo da prefeitura primeiro.");
    showScreen("setup");
    return;
  }
  return prepareEmailByType(item, "prefeitura", destination, getPrefeituraDocumentEntries(item));
}

async function prepareEmailByType(item, type, destination, documentsDefinition) {
  const d = item.data || {};
  const nome = d.pessoa_nome || extractNameFromFolder(item.folder.name) || "";
  const cpf = d.pessoa_cpf || d["CPF mascara"] || "";
  const endereco = d.imovel_endereco_completo || "";
  const processo = d.projeto_numero || extractProcessNumber(item.folder.name) || "";
  const documents = documentsDefinition.filter(x => x.file);

  if (!documents.length) { showToast("Nenhum documento foi encontrado para este envio."); return; }

   const setProgress = (text) => {
    try {
      gmailWindow.document.title = "Envio de documentos";
      gmailWindow.document.body.innerHTML = `<div style="font-family:Arial,sans-serif;padding:30px"><h2>Envio de documentos</h2><p>${escapeHtml(text)}</p></div>`;
    } catch (_) {}
    const message = $("detail-message");
    if (message) message.innerHTML = `<div class="loading"><div class="spinner"></div>${escapeHtml(text)}</div>`;
  };

  try {
    setProgress("Compartilhando documentos...");
    const shareResult = await shareDocumentsIndividually(documents, destination, (i,total,label) => setProgress(`Compartilhando ${i}/${total}: ${label}`));
    const sharedDocuments = documents.filter(entry => {
      const r = shareResult.find(x => x.fileId === entry.file.id);
      return !r || r.shared;
    });
    const failures = shareResult.filter(x => !x.shared);

    const subject = type === "cliente"
      ? `DOCUMENTOS_LEVANTAMENTO_TOPOGRÁFICO-${sanitizeSubjectName(nome)}`
      : `DOCUMENTOS_DIGITAIS_PROCESSO_${sanitizeSubjectName(nome)}`;

    const saudacao = getGreeting();
    const documentLinksText = documents
  .map(({emailLabel, file}) => {
    const url = file.webViewLink || driveViewLink(file.id);
    return `${emailLabel}:\n${url}`;
  })
  .join("\n\n");

    const introText = type === "cliente"
      ? `${saudacao}!\n\nSegue abaixo os links para os arquivos digitais referentes ao levantamento topográfico do imóvel localizado na ${endereco}, de posse de ${nome}, CPF n° ${cpf}.\n\nPara acessar os arquivos digitais, utilize os links individuais abaixo:\n\n`
      : `${saudacao}!\n\nSegue abaixo os links para os arquivos digitais do procedimento referente ao imóvel localizado na ${endereco}, de posse de ${nome}, CPF n° ${cpf}.\n\nPara acessar os arquivos digitais, utilize os links individuais abaixo:\n\n`;

    const bodyText = `${introText}${documentLinksText}\n\nAtenciosamente,\n\nAgibel Santos\nTécnico Geomensor`;

    // Abrimos o Gmail por URL de composição, como nas versões anteriores.
    // Não criamos rascunho pela API e não anexamos imagem.
    // const gmailUrl = "https://mail.google.com/mail/?view=cm&fs=1" +
    //   `&to=${encodeURIComponent(destination)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
    // setProgress("Abrindo o Gmail com o e-mail pronto...");
    // gmailWindow.location.href = gmailUrl;

     const isAndroid = /Android/i.test(navigator.userAgent);

     setProgress("Abrindo o e-mail com os dados preenchidos...");
      
      if (isAndroid) {
        // No Android, usa mailto para entregar a composição
        // ao aplicativo de e-mail (Gmail).
        const mailtoUrl =
          `mailto:${encodeURIComponent(destination)}` +
          `?subject=${encodeURIComponent(subject)}` +
          `&body=${encodeURIComponent(bodyText)}`;
      
        window.location.href = mailtoUrl;
      
      } else {
        // No computador, mantém o Gmail Web como já funciona.
        const gmailUrl =
          "https://mail.google.com/mail/?view=cm&fs=1" +
          `&to=${encodeURIComponent(destination)}` +
          `&su=${encodeURIComponent(subject)}` +
          `&body=${encodeURIComponent(bodyText)}`;
      
        window.open(gmailUrl, "_blank");
      }

    markProcessSent(processo, type);
    renderProcessList();
    renderProcessDetail(item);

    const message = $("detail-message");
    if (message) message.innerHTML = failures.length
      ? `<div class="warning-box">Gmail foi aberto. ${failures.length} arquivo(s) não puderam ser compartilhados automaticamente.<br><br>${failures.map(x => escapeHtml(x.label + ": " + x.error)).join("<br>")}</div>`
      : `<div class="success-box">Gmail aberto. ${sharedDocuments.length} documento(s) foram compartilhados individualmente para ${type === "cliente" ? "o cliente" : "a prefeitura"}.</div>`;
  } catch (err) {
    console.error(err);
    // try { gmailWindow.close(); } catch (_) {}
    const message = $("detail-message");
    if (message) message.innerHTML = `<div class="error-box">Não foi possível preparar o e-mail.<br><br>${escapeHtml(err.message || "Erro desconhecido")}</div>`;
  }
}


function buildEmailHtml({ type, saudacao, endereco, nome, cpf, documents }) {
  const intro = type === "cliente"
    ? `Segue abaixo os links para os arquivos digitais referentes ao levantamento topográfico do imóvel localizado na ${escapeHtml(endereco)}, de posse de ${escapeHtml(nome)}, CPF n° ${escapeHtml(cpf)}.`
    : `Segue abaixo os links para os arquivos digitais do procedimento referente ao imóvel localizado na ${escapeHtml(endereco)}, de posse de ${escapeHtml(nome)}, CPF n° ${escapeHtml(cpf)}.`;

  const links = documents.map(({emailLabel, file}) => {
    const url = file.webViewLink || driveViewLink(file.id);
    return `<div style="margin:0 0 12px 0;"><strong>${escapeHtml(emailLabel)}</strong><br><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></div>`;
  }).join("");

// return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">

return `<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">

<p>${escapeHtml(saudacao)}!</p>
<p>${intro}</p>
<p>Para acessar os arquivos digitais, utilize os links individuais abaixo:</p>
${links}
<p>Atenciosamente t,</p>
<table cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
<tr>
<td style="vertical-align:middle;padding-right:14px;">
</td>
<td style="vertical-align:middle;font-family:Arial,Helvetica,sans-serif;">
<div style="font-size:22px;line-height:1.1;font-weight:600;">
<span style="color:#666;">Agibel</span> <span style="color:#ff7a00;">Santos</span>
</div>
<div style="font-size:14px;line-height:1.4;color:#000;margin-top:4px;">Técnico Geomensor</div>
</td>
</tr>
</table>
</body></html>`;

// <p>Atenciosamente,</p>
// <p><strong>Agibel Santos</strong><br>Técnico Geomensor</p>
// </body></html>`;
}

async function shareDocumentsIndividually(documents, destination, onProgress) {
  const results = [];
  const total = documents.length;
  let done = 0;

  await Promise.all(documents.map(async (entry) => {
    try {
      if (onProgress) onProgress(Math.min(done + 1, total), total, entry.label || entry.file.name);

      // Tenta criar diretamente. Se a permissão já existir, o Drive normalmente retorna
      // conflito/erro; nesse caso tratamos como "já compartilhado" para não fazer uma
      // segunda chamada de listagem de permissões.
      await withTimeout(gapi.client.drive.permissions.create({
        fileId: entry.file.id,
        supportsAllDrives: true,
        sendNotificationEmail: false,
        fields: "id,type,emailAddress,role",
        resource: { type: "user", role: "reader", emailAddress: destination }
      }), 30000, `Tempo excedido ao compartilhar ${entry.file.name}.`);

      results.push({ label: entry.label, fileId: entry.file.id, shared: true });
    } catch (err) {
      const status = err?.result?.error?.code || err?.status;
      const text = err?.result?.error?.message || err.message || "Erro ao compartilhar arquivo.";
      const already = status === 409 || /already|exist|duplicate|permission/i.test(text);
      results.push({ label: entry.label, fileId: entry.file.id, shared: already, already, error: already ? "Já compartilhado" : text });
    } finally {
      done++;
      if (onProgress) onProgress(done, total, entry.label || entry.file.name);
    }
  }));

  return results;
}

async function findChildFolderByNormalizedName(parentId, name) {
  const children = await listChildren(parentId);
  const wanted = normalize(name);
  return children.find(f =>
    f.mimeType === "application/vnd.google-apps.folder" && normalize(f.name) === wanted
  ) || null;
}

async function findChildFolder(parentId, name) {
  const q =
    `'${escapeDriveQuery(parentId)}' in parents and ` +
    `name = '${escapeDriveQuery(name)}' and ` +
    `mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const response = await gapi.client.drive.files.list({
    q,
    pageSize: 10,
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)"
  });

  return response.result.files?.[0] || null;
}

async function listChildren(parentId) {
  let all = [];
  let pageToken = null;

  do {
    const response = await gapi.client.drive.files.list({
      q: `'${escapeDriveQuery(parentId)}' in parents and trashed = false`,
      pageSize: 1000,
      pageToken,
      orderBy: "name",
      fields: "nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,size)"
    });

    all = all.concat(response.result.files || []);
    pageToken = response.result.nextPageToken || null;
  } while (pageToken);

  return all;
}

async function readXlsxFromDrive(fileId) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Não foi possível baixar a planilha. HTTP ${response.status}.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: "array" });

  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(firstSheet, {
    defval: "",
    raw: false
  });

  if (!rows.length) return {};

  const row = rows[0];
  const normalized = {};

  Object.entries(row).forEach(([key, value]) => {
    normalized[normalize(key)] = String(value ?? "").trim();
  });

  return {
    ...row,
    projeto_numero: getField(normalized, [
      "projeto_numero", "projeto numero", "numero processo", "processo", "n processo"
    ]),
    pessoa_nome: getField(normalized, [
      "pessoa_nome", "pessoa nome", "nome", "nome completo"
    ]),
    pessoa_cpf: getField(normalized, [
      "pessoa_cpf", "pessoa cpf", "cpf"
    ]),
    trt: getField(normalized, [
      "trt", "numero trt", "n trt"
    ]),
    "CPF mascara": getField(normalized, [
      "cpf mascara", "cpf mascarado", "cpf"
    ]),
    imovel_endereco_completo: getField(normalized, [
      "imovel_endereco_completo", "imovel endereco completo", "endereco imovel",
      "endereco completo imovel", "endereco"
    ]),
    email: getField(normalized, ["email", "e mail", "email cliente", "e mail cliente"]),
    tipo_servico: getField(normalized, ["tipo_servico", "tipo servico", "servico", "tipo de servico"])
  };
}

function getField(obj, aliases) {
  for (const alias of aliases) {
    const key = normalize(alias);
    if (obj[key] !== undefined && obj[key] !== "") return obj[key];
  }
  return "";
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProcessNumber(folderName) {
  const match = String(folderName).match(/^\d{8}-\d+/);
  return match ? match[0] : "";
}

function extractNameFromFolder(folderName) {
  const match = String(folderName).match(/^\d{8}-\d+_(.+)$/);
  return match ? match[1].replace(/_/g, " ") : "";
}

function sanitizeSubjectName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const target = $(`screen-${name}`);
  if (target) target.classList.add("active");

  if (name === "setup") $("input-dest-email").focus();
}

function setOnline(value) {
  const dot = $("connection-status");
  dot.classList.toggle("online", value);
  dot.classList.toggle("offline", !value);
  dot.title = value ? "Google conectado" : "Desconectado";
}

function showLoginError(message) {
  const el = $("login-error");
  el.textContent = message;
  el.classList.remove("hidden");
}

function handleError(message) {
  console.error(message);
  showLoginError(message);
  setOnline(false);
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3500);
}

function registerServiceWorker() {
  if (!CONFIG.ENABLE_SERVICE_WORKER) return;
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js")
        .catch(err => console.warn("Service Worker:", err));
    });
  }
}
