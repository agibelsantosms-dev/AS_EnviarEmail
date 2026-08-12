REURB - Envio de documentos - V15

PACOTE PARA GITHUB PAGES / PWABUILDER

1) Publique todos os arquivos desta pasta na raiz de um repositório GitHub.
2) Ative GitHub Pages para o branch/pasta onde os arquivos foram publicados.
3) Abra a URL HTTPS do GitHub Pages no navegador.
4) No Google Cloud, em Google Auth Platform > Clients, adicione a ORIGEM do GitHub Pages em “Origens JavaScript autorizadas”.
   Exemplo de origem: https://SEUUSUARIO.github.io
   Não inclua /nome-do-repositorio na origem.
5) Mantenha o e-mail da conta Google como usuário de teste enquanto o app estiver em Testing.
6) Abra a URL do GitHub Pages e faça login.
7) Depois que o site estiver funcionando, use https://www.pwabuilder.com/ para analisar a PWA e gerar o pacote Android/Windows conforme necessário.

IMPORTANTE
- O app usa Google Drive/Gmail e, portanto, precisa de internet para login, leitura do Drive, compartilhamento e preparação do e-mail.
- O client ID OAuth que está no app não é uma senha; a segurança depende das origens autorizadas no Google Cloud e das permissões concedidas pelo usuário.
- Para GitHub Pages, use HTTPS.

TESTE LOCAL
py -m http.server 5501
Abrir: http://localhost:5501

ESTRUTURA ESPERADA NO DRIVE
A.S_AGRIMENSOR / 1.LEVANTAMENTOS_TOPOGRAFICOS / PROCESSO

DOCUMENTOS
- 2.PROJETO_CAD / numero_do_processo_CAD.dwg
- 3.DOCUMENTOS / COMPLEMENTAR / Comp_TRFU (pdf/jpg/jpeg/png)
- 3.DOCUMENTOS / 2.MEMORIAL_DESCRITIVO.pdf
- 3.DOCUMENTOS / 3.1.PLANTA_TOPOGRÁFICA.pdf
- 3.DOCUMENTOS / 3.2.PLANTA_LOCALIZAÇÃO.pdf
- 3.DOCUMENTOS / 4.TRT_(numero).pdf
- 3.DOCUMENTOS / 5.REQUERIMENTO_REURB.pdf
- 3.DOCUMENTOS / 6.FICHA_IDENTIFICAÇÃO_OCUPANTE-IMÓVEL.pdf
- Cliente_Serviço Consulta.xlsx


V15 - Envio separado para cliente e prefeitura.
- Todo serviço pode enviar para o cliente.
- Prefeitura somente para TIPO_SERVICO = REURB.
- EMAIL e TIPO_SERVICO devem existir no XLSX.
- Declaração Técnico-Proprietário vai somente para o cliente.
- Prefeitura não recebe a declaração.
- Não é criado ZIP; são usados somente links individuais dos arquivos existentes no Drive.


V15 - Ajustes:
- Exibe Dados brutos e Declaração como encontrados/não encontrados na tela do processo.
- Exibe links individuais de todos os documentos encontrados.
- Cliente recebe Declaração Técnico-Proprietário e Dados brutos; Prefeitura não recebe esses dois.
- E-mail do Gmail é criado como rascunho HTML com assinatura gráfica e texto Agibel/Santos.
- Requer autorização Google adicional para Gmail Compose.
- Não cria ZIP nem pasta adicional no Drive.


V15: o envio abre diretamente a tela de composição do Gmail com o e-mail pronto para revisão e envio. Não cria rascunho via API e não usa imagem de assinatura. Assinatura textual: Agibel Santos / Técnico Geomensor.
