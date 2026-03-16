require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

// 1. CONFIGURAÇÃO DE CORS
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 2. MIDDLEWARES
// Reduzi o limite para 10mb para evitar sobrecarga, 50mb é muito alto para JSON comum
app.use(express.json({ limit: '10mb' }));

// 3. CONEXÃO MONGODB
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
    console.error("❌ ERRO: Verifique a variável MONGO_URI no painel do Koyeb.");
    process.exit(1);
}

// Configuração para melhorar a performance da conexão
mongoose.connect(mongoURI)
  .then(() => console.log('✅ MongoDB Conectado com Sucesso'))
  .catch(err => console.error('❌ Erro de Conexão MongoDB:', err));

// 4. MODELS
// Adicionado index: true no campo 'data' para buscas mais rápidas
const Jason = mongoose.model('Jason', new mongoose.Schema({ nick: String, descricao: String, data: { type: Date, default: Date.now, index: true } }), 'jasons');

const Noticia = mongoose.model('Noticia', new mongoose.Schema({
    titulo: String,
    conteudo: String,
    imagem: String,
    data: { type: Date, default: Date.now, index: true },
    enquete: {
        pergunta: String,
        expiraEm: Date,
        opcoes: [{
            texto: String,
            votos: { type: Number, default: 0 }
        }],
        votosTotais: { type: Number, default: 0 }
    }
}), 'noticias');

const PollVote = mongoose.model('PollVote', new mongoose.Schema({
    noticiaId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    voterKey: { type: String, required: true, index: true },
    data: { type: Date, default: Date.now, index: true }
}, {
    timestamps: false
}), 'poll_votes');

PollVote.schema.index({ noticiaId: 1, voterKey: 1 }, { unique: true });
const Equipe = mongoose.model('Equipe', new mongoose.Schema({ cargo: String, nick: String }), 'equipes');
const Ranking = mongoose.model('Ranking', new mongoose.Schema({ pontos: Number, tipo: String, nick: String }), 'rankings');
const VipProduct = mongoose.model('VipProduct', new mongoose.Schema({ titulo: String, descricao: String, valor: String, imagem: String }), 'vips');
const Configuracao = mongoose.model('Configuracao', new mongoose.Schema({ chave: String, valor: String }), 'configs');
const Mensagem = mongoose.model('Mensagem', new mongoose.Schema({
    chatId: { type: String, index: true }, 
    remetente: String, 
    texto: String, 
    imagem: String, 
    arquivo: String, 
    nomeArquivo: String, 
    data: { type: Date, default: Date.now, index: true }
}), 'mensagens');
const UserStatus = mongoose.model('UserStatus', new mongoose.Schema({
    chatId: { type: String, unique: true }, 
    bloqueado: { type: Boolean, default: false }, 
    mutado: { type: Boolean, default: false }
}), 'user_status');

// 5. FUNÇÃO DE ROTAS
const setupRoutes = (pathName, model) => {
    app.get(`/api/${pathName}`, async (req, res) => {
        try { 
            // Lean() faz a consulta ser muito mais rápida (retorna JS puro em vez de documentos Mongoose)
            const itens = await model.find().sort({ data: -1 }).lean(); 
            res.json(itens); 
        } catch (e) { res.status(500).json([]); }
    });
    
    app.post(`/api/${pathName}`, async (req, res) => {
        try { 
            const novoItem = await new model(req.body).save(); 
            res.json(novoItem); 
        } catch (e) { res.status(400).send(e); }
    });

    app.put(`/api/${pathName}/:id`, async (req, res) => {
        try { 
            const itemAtualizado = await model.findByIdAndUpdate(req.params.id, req.body, { new: true }); 
            res.json(itemAtualizado); 
        } catch (e) { res.status(400).send(e); }
    });

    app.delete(`/api/${pathName}/:id`, async (req, res) => {
        try { 
            await model.findByIdAndDelete(req.params.id); 
            res.json({ ok: true }); 
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
};

setupRoutes('galeria', Jason);
setupRoutes('noticias', Noticia);
setupRoutes('equipe', Equipe);
setupRoutes('ranking', Ranking);
setupRoutes('vip', VipProduct);

// 5.1 VOTAÇÃO DE ENQUETE (NOTÍCIAS)
app.post('/api/noticias/:id/votar', async (req, res) => {
    try {
        const { opcaoIndex, voterKey } = req.body || {};

        if (typeof voterKey !== 'string' || voterKey.trim().length < 10) {
            return res.status(400).json({ error: "voterKey inválido" });
        }
        if (!Number.isInteger(opcaoIndex)) {
            return res.status(400).json({ error: "opcaoIndex inválido" });
        }

        const noticia = await Noticia.findById(req.params.id).lean();
        if (!noticia) return res.status(404).json({ error: "Notícia não encontrada" });

        const enquete = noticia.enquete;
        if (!enquete || !Array.isArray(enquete.opcoes) || enquete.opcoes.length < 2) {
            return res.status(400).json({ error: "Notícia não possui enquete" });
        }
        if (opcaoIndex < 0 || opcaoIndex >= enquete.opcoes.length) {
            return res.status(400).json({ error: "Opção inválida" });
        }
        if (enquete.expiraEm && new Date(enquete.expiraEm).getTime() <= Date.now()) {
            return res.status(403).json({ error: "Enquete expirada" });
        }

        // impede voto duplicado por dispositivo (voterKey)
        try {
            await new PollVote({ noticiaId: noticia._id, voterKey }).save();
        } catch (e) {
            if (e && e.code === 11000) {
                return res.status(409).json({ error: "Você já votou nessa enquete" });
            }
            throw e;
        }

        const incPath = `enquete.opcoes.${opcaoIndex}.votos`;
        const updated = await Noticia.findByIdAndUpdate(
            noticia._id,
            { $inc: { [incPath]: 1, 'enquete.votosTotais': 1 } },
            { new: true }
        ).lean();

        return res.json({ ok: true, enquete: updated?.enquete || null });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Erro ao votar" });
    }
});

// 6. ROTAS DE SUPORTE E CHAT
app.post('/api/suporte/enviar', async (req, res) => {
    try {
        const status = await UserStatus.findOne({ chatId: req.body.chatId }).lean();
        if (req.body.remetente === 'usuario') {
            if (status?.bloqueado) return res.status(403).json({ error: "Bloqueado" });
            if (status?.mutado && req.body.texto) return res.status(403).json({ error: "Mutado" });
        }
        const msg = await new Mensagem(req.body).save();
        res.json(msg);
    } catch (e) { res.status(400).send(e); }
});

app.get('/api/suporte/chat/:chatId', async (req, res) => {
    try {
        const msgs = await Mensagem.find({ chatId: req.params.chatId }).sort({ data: 1 }).lean();
        const status = await UserStatus.findOne({ chatId: req.params.chatId }).lean();
        res.json({ msgs, status: status || { bloqueado: false, mutado: false } });
    } catch (e) { res.status(500).json({ msgs: [] }); }
});

app.get('/api/suporte/admin/lista', async (req, res) => {
    try {
        const chats = await Mensagem.aggregate([
            { $sort: { data: 1 } },
            { $group: { _id: "$chatId", primeiraMsg: { $first: "$data" } } },
            { $sort: { primeiraMsg: 1 } }
        ]);
        res.json(chats);
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/suporte/moderacao', async (req, res) => {
    try {
        const { chatId, acao, valor } = req.body;
        const up = {}; up[acao] = valor;
        await UserStatus.findOneAndUpdate({ chatId }, up, { upsert: true });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false }); }
});

// 7. ROTAS DE CONFIGURAÇÃO
app.post('/api/config', async (req, res) => {
    const { chave, valor } = req.body;
    const conf = await Configuracao.findOneAndUpdate({ chave }, { valor }, { upsert: true, new: true });
    res.json(conf);
});

app.get('/api/config/:chave', async (req, res) => {
    try {
        const conf = await Configuracao.findOne({ chave: req.params.chave }).lean();
        res.json(conf || { valor: "" });
    } catch (e) { res.json({ valor: "" }); }
});

app.get('/', (req, res) => { res.send('API Fuja do Jason está Online! 🔒'); });

// 8. INICIALIZAÇÃO
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
