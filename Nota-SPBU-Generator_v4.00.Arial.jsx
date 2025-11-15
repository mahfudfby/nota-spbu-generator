import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, query, onSnapshot, deleteDoc } from 'firebase/firestore';

// --- GLOBAL CONFIG & UTILITIES ---
// Link Gemini Share : https://gemini.google.com/share/81cf6669d9f6
// Pastikan variabel global tersedia (disediakan oleh Canvas environment)
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const apiKey = ""; // API Key untuk Gemini, akan diisi saat runtime

const LOGO_MAX_WIDTH = 204;
const FALLBACK_LOGO_URL = `https://placehold.co/${LOGO_MAX_WIDTH}x70/ff0000/ffffff?text=LOGO+SPBU`; 
const LOCKED_FOOTER_TEXT = " TERIMAKASIH ATAS KUNJUNGAN ANDA \n____________________________\n____________________________\n____________________________\n____________________________\n____________________________\n"; 

// --- KONSTANTA DUKUNGAN BARU ---
const TRAKTEER_LINK = "https://drive.google.com/file/d/1dOBzvlBYWjHvPdpKzRNNTYqqoPTwQq0Y/view?usp=sharing";

// Helper untuk format Rupiah
const formatRupiah = (number) => {
    if (number === null || number === undefined || isNaN(number)) return '0';
    return Math.round(number).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
};

// Helper untuk format Waktu (HH:MM)
const formatTime = (date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
};

// Helper untuk format Tanggal (DD/MM/YYYY)
const formatDate = (date) => {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
};

// Helper untuk generate ID
const generateId = () => 'spbu-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

// Helper untuk resize gambar dan konversi ke Base64 (untuk logo)
const resizeImageAndGetBase64 = (file, maxWidth, callback) => {
    const reader = new FileReader();
    reader.onload = (readerEvent) => {
        const img = new Image();
        img.onload = () => {
            let width = img.width;
            let height = img.height;
            if (width > maxWidth) {
                height = height * (maxWidth / width);
                width = maxWidth;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            callback(dataUrl);
        };
        img.src = readerEvent.target.result;
    };
    reader.readAsDataURL(file);
};

// Helper untuk API Call dengan Exponential Backoff
const fetchWithBackoff = async (url, options, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response;
    } catch (error) {
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000 + Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw new Error("Gagal melakukan panggilan API setelah beberapa percobaan.");
      }
    }
  }
};


// --- INITIAL DATA STRUCTURES ---

const initialTransactionData = {
    shift: '1',
    noTrans: Math.floor(100000 + Math.random() * 900000).toString(),
    date: formatDate(new Date()),
    time: formatTime(new Date()),
    islandPump: '1',
    productName: 'Pertalite',
    pricePerLiter: 10000,
    volume: 10.0,
    cashAmount: 100000, // Nominal Beli/Total Harga
    operator: 'Admin',
    nopol: 'DR 1234 XY',
};

const initialSpbuConfig = {
    name: 'SPBU PERTAMINA 00.000.00',
    address: 'ALAMAT SPBU LENGKAP',
    footerNote: LOCKED_FOOTER_TEXT,
    receiptWidth: 275, 
    id: generateId(),
    logoBase64: null, 
};

// --- RENDER HELPERS (MEMOIZED INPUT COMPONENT) ---
// DIPINDAHKAN KELUAR DARI APP DAN DI-MEMOIZED UNTUK MENJAGA FOKUS
const TransactionInput = React.memo(({ label, name, value, inputType = 'text', disabled = false, showSyncButton = false, showRandomButton = false, onChange, updateDateTime, generateRandomId, isProcessing, isAiGenerating }) => {
    const isTel = inputType === 'tel';
    
    let displayValue = value;
    if (isTel && value === 0 && !disabled) {
        displayValue = ''; 
    } else if (isTel) {
        displayValue = String(value);
    }

    return (
        <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">{label}</label>
            <div className="flex items-center space-x-1">
                <input 
                    type={isTel ? 'text' : inputType} 
                    name={name} 
                    value={displayValue}
                    onChange={onChange}
                    disabled={disabled || isProcessing || isAiGenerating} 
                    className={`w-full p-2 border rounded-lg transition ${disabled ? 'bg-gray-200 cursor-not-allowed' : 'bg-white'} ${isProcessing || isAiGenerating ? 'opacity-70' : ''}`} 
                    inputMode={isTel ? 'numeric' : 'text'}
                />
                {/* Tombol Sync BARU (untuk Jam/Tanggal) */}
                {showSyncButton && (
                    <button type="button" onClick={updateDateTime} disabled={isProcessing || isAiGenerating}
                        className={`bg-indigo-500 hover:bg-indigo-600 text-white p-2 rounded-lg transition duration-150 transform hover:scale-105 ${isProcessing || isAiGenerating ? 'opacity-50 cursor-not-allowed' : ''}`} title="Gunakan waktu sekarang">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" /></svg>
                    </button>
                )}
                {/* Tombol Random ID BARU (untuk No.Trans) */}
                {showRandomButton && (
                    <button type="button" onClick={generateRandomId} disabled={isProcessing || isAiGenerating}
                        className={`bg-purple-500 hover:bg-purple-600 text-white p-2 rounded-lg transition duration-150 transform hover:scale-105 ${isProcessing || isAiGenerating ? 'opacity-50 cursor-not-allowed' : ''}`} title="Generate No. Transaksi Acak">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181-3.183a8.25 8.25 0 0113.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0 0h-4.992m-2.285 3.96M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );
});


// --- MAIN REACT COMPONENT ---
const App = () => {
    // --- STATE MANAGEMENT ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    
    const [spbuList, setSpbuList] = useState([]);
    const [selectedSpbuId, setSelectedSpbuId] = useState('');
    const [currentSpbu, setCurrentSpbu] = useState(initialSpbuConfig);
    const [transactionData, setTransactionData] = useState(initialTransactionData);
    
    const [uiState, setUiState] = useState('view'); // 'view', 'edit', 'new'
    const [feedback, setFeedback] = useState(null); // { message, type }
    const [isProcessing, setIsProcessing] = useState(false);
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [isLibReady, setIsLibReady] = useState(false);

    // --- EFFECT: FIREBASE INITIALIZATION & AUTH ---
    useEffect(() => {
        if (Object.keys(firebaseConfig).length === 0) {
            setFeedback({ message: 'Kesalahan: Konfigurasi Firebase tidak tersedia.', type: 'error' });
            setIsAuthReady(true);
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const authInstance = getAuth(app);
            const dbInstance = getFirestore(app);
            setAuth(authInstance);
            setDb(dbInstance);

            const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
                if (user) {
                    setUserId(user.uid);
                } else if (initialAuthToken) {
                    try {
                        await signInWithCustomToken(authInstance, initialAuthToken);
                        setUserId(authInstance.currentUser?.uid);
                    } catch (e) {
                        console.error('Custom token sign-in failed, signing in anonymously.', e);
                        await signInAnonymously(authInstance);
                        setUserId(authInstance.currentUser?.uid);
                    }
                } else {
                    await signInAnonymously(authInstance);
                    setUserId(authInstance.currentUser?.uid);
                }
                setIsAuthReady(true);
            });

            return () => unsubscribe();
        } catch (e) {
            setFeedback({ message: `Init Error: ${e.message}`, type: 'error' });
            setIsAuthReady(true);
        }
    }, []);

    // --- EFFECT: FIRESTORE DATA LISTENER (SPBU CONFIGS) ---
    useEffect(() => {
        if (!db || !isAuthReady) return;

        // Path: /artifacts/{appId}/public/data/spbu_configs
        const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'spbu_configs'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setSpbuList(list);
            
            // Sinkronisasi SPBU yang dipilih setelah pembaruan list
            setSelectedSpbuId(prevId => {
                const isCurrentStillInList = list.some(s => s.id === prevId);
                return isCurrentStillInList && prevId ? prevId : list.length > 0 ? list[0].id : '';
            });

        }, (e) => console.error('Gagal memuat data SPBU:', e));

        return () => unsubscribe();
    }, [db, isAuthReady]);

    // --- EFFECT: SYNC currentSpbu when selectedSpbuId or spbuList changes ---
    useEffect(() => {
        const selected = spbuList.find(s => s.id === selectedSpbuId);
        if (selected) {
            // Selalu timpa footer dengan teks terkunci saat memilih/memuat
            setCurrentSpbu({ ...selected, footerNote: LOCKED_FOOTER_TEXT });
        } else {
            // Default jika tidak ada data atau template baru
            setCurrentSpbu(initialSpbuConfig);
            if (spbuList.length > 0) setSelectedSpbuId(spbuList[0].id);
        }
    }, [selectedSpbuId, spbuList]);

    // --- EFFECT: LOAD HTML2CANVAS ---
    useEffect(() => {
        if (window.html2canvas) {
            setIsLibReady(true);
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        script.async = true;
        script.onload = () => setIsLibReady(true);
        script.onerror = () => setFeedback({ message: 'Gagal memuat library pencetakan.', type: 'error' });
        document.body.appendChild(script);
    }, []);
    
    // --- DERIVED STATE / CALCULATIONS ---

    const { calculatedVolume, finalPrice, isVolumeCalculated } = useMemo(() => {
        // FIX: Mengganti pricePerLiter yang tidak terdefinisi menjadi pL (Local Price Liter)
        const pL = parseFloat(transactionData.pricePerLiter) || 0; // Local Price Liter
        const nominalBeli = parseFloat(transactionData.cashAmount) || 0;

        let calculatedVolume = parseFloat(transactionData.volume) || 0;
        let finalPrice = nominalBeli;
        let isVolumeCalculated = false;

        // Menggunakan pL untuk kalkulasi
        if (nominalBeli > 0 && pL > 0) {
            calculatedVolume = nominalBeli / pL;
            isVolumeCalculated = true;
            finalPrice = nominalBeli;
        } else if (calculatedVolume > 0 && pL > 0) {
            finalPrice = calculatedVolume * pL;
        } else {
            calculatedVolume = 0;
            finalPrice = 0;
        }
        
        return { calculatedVolume, finalPrice, isVolumeCalculated };
    }, [transactionData]);


    // --- HANDLERS & LOGIC FUNCTIONS ---
    
    const displayFeedback = useCallback((message, type) => {
        setFeedback({ message, type });
        setTimeout(() => setFeedback(null), 5000);
    }, []);

    const handleTransactionChange = useCallback((e) => {
        const { name, value } = e.target;
        let newValue = value;
        
        setTransactionData(prev => {
            let update = { ...prev };
            
            if (['volume', 'pricePerLiter', 'cashAmount'].includes(name)) {
                // Hapus semua kecuali angka dan satu titik (untuk desimal)
                newValue = newValue.replace(/[^0-9.]/g, ''); 
                const floatValue = parseFloat(newValue) || 0;
                
                update[name] = floatValue;

                // Logika Kalkulasi: Jika Volume diubah saat Nominal Beli terisi, reset Nominal Beli
                if (name === 'volume' && prev.cashAmount > 0) {
                    update.cashAmount = 0; 
                }
            } else {
                update[name] = value;
            }
            return update;
        });
    }, []);

    const handleSpbuChange = useCallback((e) => {
        const { name, value } = e.target;
        
        if (name === 'footerNote') return;
        
        setCurrentSpbu(prev => ({
            ...prev,
            [name]: name === 'receiptWidth' ? (parseInt(value) || 275) : value,
        }));
    }, []);

    const updateDateTime = useCallback(() => {
        const now = new Date();
        setTransactionData(prev => ({
            ...prev,
            date: formatDate(now),
            time: formatTime(now),
        }));
        displayFeedback('Tanggal dan waktu diperbarui.', 'info');
    }, [displayFeedback]);

    // BARU: Fungsi untuk menghasilkan ID Transaksi acak 6 digit
    const generateRandomTransId = useCallback(() => {
        const randomId = Math.floor(100000 + Math.random() * 900000).toString();
        setTransactionData(prev => ({ ...prev, noTrans: randomId }));
        displayFeedback('Nomor Transaksi acak berhasil dibuat.', 'info');
    }, [displayFeedback]);


    const handleImageUpload = useCallback((e) => {
        const file = e.target.files[0];
        if (!file) return;

        displayFeedback('Sedang memproses gambar...', 'info');
        
        resizeImageAndGetBase64(file, LOGO_MAX_WIDTH, (base64Data) => {
            setCurrentSpbu(prev => ({ ...prev, logoBase64: base64Data }));
            displayFeedback('Gambar berhasil diupload dan diresize. Jangan lupa klik Simpan.', 'success');
        });
    }, [displayFeedback]);
    
    const handleClearLogo = useCallback(() => {
        setCurrentSpbu(prev => ({ ...prev, logoBase64: null }));
        // Reset input file (secara manual, karena React tidak mengontrol type="file" value)
        document.getElementById('logo-upload').value = ''; 
        displayFeedback('Logo berhasil dihapus.', 'info');
    }, [displayFeedback]);

    const handleSaveSpbu = useCallback(async () => {
        if (!db || !currentSpbu.name) return displayFeedback('Nama SPBU wajib diisi.', 'error');
        setIsProcessing(true);
        
        try {
            const spbuToSave = { 
                ...currentSpbu, 
                footerNote: LOCKED_FOOTER_TEXT, 
                // Jika ID sudah ada di list, gunakan yang itu. Jika tidak, generate baru.
                id: currentSpbu.id && spbuList.find(s => s.id === currentSpbu.id) ? currentSpbu.id : generateId()
            }; 
            
            // Simpan ke Firestore
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'spbu_configs', spbuToSave.id), spbuToSave, { merge: true });
            
            // Update state
            setSelectedSpbuId(spbuToSave.id);
            setUiState('view');
            displayFeedback('Template berhasil disimpan!', 'success');

        } catch (e) { 
            console.error('Gagal simpan:', e);
            displayFeedback(`Gagal simpan: ${e.message}`, 'error'); 
        } finally {
            setIsProcessing(false);
        }
    }, [db, currentSpbu, spbuList, displayFeedback]);

    const handleDeleteSpbu = useCallback(async () => {
        if (!db || !currentSpbu.id || !window.confirm(`Yakin ingin menghapus template SPBU "${currentSpbu.name}"?`)) return;
        setIsProcessing(true);
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'spbu_configs', currentSpbu.id));
            setSelectedSpbuId(''); // Dipilih otomatis ke yang pertama di list
            setUiState('view');
            displayFeedback('Template berhasil dihapus.', 'success');
        } catch (e) {
            console.error('Gagal hapus:', e);
            displayFeedback(`Gagal hapus: ${e.message}`, 'error');
        } finally {
            setIsProcessing(false);
        }
    }, [db, currentSpbu, displayFeedback]);

    const handleAiGenerateTemplate = useCallback(async () => {
        if (!currentSpbu.name) return displayFeedback('Isi nama SPBU dulu.', 'error');
        if(isAiGenerating) return;
        
        setIsAiGenerating(true);
        displayFeedback('✨ Sedang membuat alamat fiktif...', 'info');

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
            const response = await fetchWithBackoff(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `Buat alamat fiktif realistis (multi-baris dengan \\n) untuk SPBU bernama: "${currentSpbu.name}". Hanya balas JSON.` }] }],
                    systemInstruction: { parts: [{ text: `Anda asisten generator nota. Batasi alamat hanya 2 baris. Balas HANYA JSON: {"address": "..."}` }] },
                    generationConfig: { responseMimeType: "application/json" }
                })
            });

            const data = await response.json();
            const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!resultText) { throw new Error("Struktur respons AI tidak valid."); }

            const result = JSON.parse(resultText);
            
            let address = result.address || currentSpbu.address;
            // Memastikan alamat maksimal 2 baris di sini
            const lines = address.split('\n');
            address = lines.slice(0, 2).join('\n');


            setCurrentSpbu(prev => ({ ...prev, address: address }));
            
            displayFeedback('✨ Alamat berhasil dibuat!', 'success');

        } catch (e) { 
            console.error("AI Generation Error:", e);
            displayFeedback(`AI Gagal: ${e.message || 'Cek koneksi internet.'}`, 'error'); 
        } finally { 
            setIsAiGenerating(false); 
        }
    }, [currentSpbu.name, displayFeedback, isAiGenerating]);

    // --- RENDER UTILITIES ---
    
    // Fungsi untuk membuat elemen HTML nota yang akan dicetak/di-export
    const ReceiptPreviewComponent = useCallback(() => {
        const trans = transactionData;
        const spbu = currentSpbu;
        const displayVolume = calculatedVolume || parseFloat(trans.volume) || 0;
        const displayPrice = finalPrice || parseFloat(trans.cashAmount) || 0;
        const priceLiter = parseFloat(trans.pricePerLiter) || 0;

        // Batasi Address hanya 2 baris saat dirender
        const addressLines = (spbu.address || '').split('\n').slice(0, 2).map((line, i) => (
            <p key={`addr-${i}`} className="text-base font-normal">{line}</p>
        ));
        
        const footerLines = (spbu.footerNote || '').split('\n').map((line, i) => (
            <p key={`footer-${i}`}>{line || ' '}</p>
        ));

        const renderReceiptRow = (label, value, isTotal = false) => (
            <div className={`flex justify-between ${isTotal ? 'text-base font-bold' : 'text-base'}`}> 
                <span className="font-normal w-32 flex-shrink-0 whitespace-nowrap">{label} :</span> 
                <span className={`flex-grow text-right ${isTotal ? 'text-base font-extrabold' : 'text-base font-normal'}`}>{value}</span>
            </div>
        );

        return (
            <div id="receipt-preview" 
                 style={{ width: `${spbu.receiptWidth || 275}px` }}
                 className="text-left p-2 text-black leading-tight font-sans"
            >
                {/* Logo Section */}
                <div className="flex justify-center mb-1">
                    <img 
                        src={spbu.logoBase64 || FALLBACK_LOGO_URL} 
                        alt="Logo SPBU" 
                        className={`max-w-[${LOGO_MAX_WIDTH}px] h-auto max-w-full filter grayscale`} 
                        onError={(e) => { e.target.onerror = null; e.target.src = FALLBACK_LOGO_URL; }} 
                    />
                </div>
                {/* SPBU Name and Address */}
                <div className="text-center font-bold mb-1"> 
                    <p className="text-lg">{spbu.name}</p>
                    {addressLines}
                </div>

                <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
                
                {/* BLOK DATA TANGGAL/SHIFT/NOTA */}
                <div className="grid grid-cols-2 gap-x-2 text-base text-center">
                    <div><p className="font-medium text-left">Shift:</p><p className="text-left">{trans.shift}</p></div>
                    <div><p className="font-medium text-right">No.Trans:</p><p className="text-right">{trans.noTrans}</p></div>
                    
                    <div className="col-span-2 border-t border-dashed border-black my-1 h-0"></div>

                    <div><p className="font-bold text-left">Tanggal:</p><p className="font-bold text-left">{trans.date}</p></div>
                    <div><p className="font-bold text-right">Jam:</p><p className="font-bold text-right">{trans.time}</p></div>
                </div>

                <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
                
                {/* Blok Data Transaksi Utama */}
                <div className="space-y-0 text-base"> 
                    {renderReceiptRow('Pulau/Pompa', trans.islandPump)}
                    {renderReceiptRow('Nama Produk', trans.productName)}
                    {renderReceiptRow('Harga/Liter', `Rp. ${formatRupiah(priceLiter)}`)}
                    {renderReceiptRow('Volume', ` (L) ${displayVolume.toFixed(2)}`)}
                    
                    {renderReceiptRow('Total Harga', `Rp. ${formatRupiah(displayPrice)}`, true)}

                    {renderReceiptRow('Operator', trans.operator)}
                    {renderReceiptRow('Nopol', trans.nopol)}
                </div>

                <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
                
                {/* Footer */}
                <div className="text-center mt-2 text-base whitespace-pre-line leading-tight font-bold">
                    {footerLines}
                </div>
            </div>
        );
    }, [transactionData, currentSpbu, calculatedVolume, finalPrice]);

    // --- EXPORT/PRINT LOGIC ---

    const generateCanvas = useCallback(async () => {
        if (!window.html2canvas || !isLibReady) {
             throw new Error('Library html2canvas belum siap. Mohon tunggu sebentar.');
        }
        const receiptEl = document.getElementById('receipt-preview');
        if (!receiptEl) {
            throw new Error('Tampilan nota tidak ditemukan.');
        }
        
        await new Promise(r => setTimeout(r, 100)); // Tunggu rendering React selesai
        
        const desiredScale = 3; 
        const devicePixelRatio = window.devicePixelRatio || 1;
        const finalScale = desiredScale / devicePixelRatio;
        const width = currentSpbu.receiptWidth || 275;

        return await window.html2canvas(receiptEl, { 
            scale: finalScale,
            useCORS: true, 
            backgroundColor: '#ffffff',
            width: width, 
        });
    }, [isLibReady, currentSpbu.receiptWidth]);

    const handleExportImage = useCallback(async () => {
        if (!isLibReady || isProcessing) return;
        setIsProcessing(true);
        try {
            const canvas = await generateCanvas();
            const link = document.createElement('a');
            link.download = `Nota-${transactionData.noTrans}-${transactionData.nopol}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            displayFeedback('Gambar berhasil diexport!', 'success');
        } catch (e) { 
            console.error('Export Error:', e);
            displayFeedback(`Gagal export: ${e.message}`, 'error'); 
        } finally { 
            setIsProcessing(false); 
        }
    }, [isLibReady, isProcessing, generateCanvas, transactionData, displayFeedback]);

    const handlePrintReceipt = useCallback(async () => {
        if (!isLibReady || isProcessing) return;
        setIsProcessing(true);
        try {
            const canvas = await generateCanvas();
            const imgData = canvas.toDataURL('image/png');
            
            const win = window.open('', '_blank');
            win.document.write(`
                <html>
                    <head>
                        <title>Cetak Nota</title>
                        <style>
                            body { margin: 0; padding: 0; background-color: #eee; display: flex; justify-content: center; }
                            img { max-width: 100%; height: auto; display: block; }
                            @media print {
                                @page { size: 58mm auto; margin: 0mm; }
                                body { 
                                    margin: 0; 
                                    width: 58mm;    
                                    background-color: transparent;
                                    display: block; 
                                }
                                .print-container { width: 100%; margin: 0; }
                                img { width: 100%; image-rendering: pixelated; }
                            }
                        </style>
                    </head>
                    <body onload="window.print();window.close()">
                        <div class="print-container">
                            <img src="${imgData}" alt="Nota Transaksi" />
                        </div>
                    </body>
                </html>
            `);
            win.document.close();
        } catch (e) { 
            console.error('Print Error:', e);
            displayFeedback(`Gagal cetak: ${e.message}`, 'error'); 
        } finally { 
            setIsProcessing(false); 
        }
    }, [isLibReady, isProcessing, generateCanvas, displayFeedback]);

    // --- RENDER MAIN LAYOUT ---

    // Tampilkan overlay loading saat autentikasi belum siap
    if (!isAuthReady) {
        return (
            <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center text-white z-50 font-sans">
                <div className="flex items-center space-x-3">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
                    <span>Memuat Aplikasi dan Data...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50 flex justify-center p-4 sm:p-8 font-sans">
            <style jsx="true">{`
                #receipt-preview {
                    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
                    line-height: 1.2;
                }
                .spinner {
                    border: 4px solid rgba(255, 255, 255, 0.3);
                    border-top: 4px solid #fff;
                    border-radius: 50%;
                    width: 16px;
                    height: 16px;
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            `}</style>

            <div className="w-full max-w-md">
                {/* Header */}
                <header className="text-center mb-6 border-b-4 border-indigo-600 pb-3 bg-white p-4 rounded-xl shadow-lg">
                    <h1 className="text-3xl font-extrabold text-gray-800">Generator Nota SPBU</h1>
                    <p className="text-sm font-medium text-gray-700 mt-1">
                        Generator Nota BBM oleh Mahfudfebry (React/Firestore)
                    </p>
                    <p className="text-xs text-gray-500">
                         User ID: {userId}
                    </p>
                </header>
                
                {/* BAGIAN TOMBOL TRAKTIR */}
                <div className="mb-6 p-4 bg-white rounded-xl shadow-lg flex flex-col items-center space-y-3">
                    <p className="text-lg font-bold text-gray-700 text-center">
                        Traktir Saya Dengan Cara Klik Tombol di Bawah Ini:
                    </p>
                    <a 
                        href={TRAKTEER_LINK}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full text-center max-w-xs bg-red-600 text-white font-extrabold text-xl p-3 rounded-xl shadow-md transition transform hover:scale-[1.02] hover:bg-red-700"
                    >
                        SCAN - Q R I S<br/>DISINI BRO
                    </a>
                </div>
                {/* AKHIR BAGIAN TOMBOL TRAKTIR */}

                {/* Feedback Message */}
                {feedback && (
                    <div className={`p-3 rounded-lg text-white mb-4 ${feedback.type === 'error' ? 'bg-red-500' : feedback.type === 'success' ? 'bg-green-500' : 'bg-blue-500'}`}>
                        {feedback.message}
                    </div>
                )}
                
                {/* --- Bagian 1: Pilih SPBU --- */}
                <div className="mb-6 p-4 bg-white rounded-xl shadow-lg">
                    <h2 className="text-xl font-bold mb-3 text-indigo-700">1. Pilih Template SPBU</h2>
                    
                    {/* DROPDOWN TEMPLATE */}
                    <select 
                        id="spbu-selector" 
                        className="w-full p-2 border rounded-lg bg-gray-50 mb-4"
                        value={selectedSpbuId}
                        onChange={(e) => {
                            setSelectedSpbuId(e.target.value);
                            setUiState('view');
                        }}
                        disabled={isProcessing || isAiGenerating || spbuList.length === 0}
                    >
                        {spbuList.length === 0 ? (
                            <option value="">Tidak Ada Template (Gunakan Default)</option>
                        ) : (
                            spbuList.map(spbu => (
                                <option key={spbu.id} value={spbu.id}>{spbu.name}</option>
                            ))
                        )}
                    </select>

                    {/* PERUBAHAN KRUSIAL: Tombol Edit dan Baru di bawah dropdown */}
                    <div className="flex justify-between space-x-2">
                        <button 
                            onClick={() => setUiState('edit')} 
                            disabled={!selectedSpbuId || isProcessing || isAiGenerating}
                            className={`flex-grow bg-yellow-500 text-white px-3 py-2 rounded-lg font-bold hover:bg-yellow-600 transition disabled:opacity-50`}
                        >
                            Edit Template
                        </button>
                        <button 
                            onClick={() => {
                                setCurrentSpbu({ ...initialSpbuConfig, id: generateId(), name: 'SPBU BARU', logoBase64: null, footerNote: LOCKED_FOOTER_TEXT, receiptWidth: 275 });
                                setUiState('new');
                            }} 
                            disabled={isProcessing || isAiGenerating}
                            className={`flex-grow bg-green-600 text-white px-3 py-2 rounded-lg font-bold hover:bg-green-700 transition disabled:opacity-50`}
                        >
                            Buat Baru
                        </button>
                    </div>
                </div>

                {/* --- Bagian Edit Template (Conditional) --- */}
                {(uiState === 'edit' || uiState === 'new') && (
                    <div className="mb-6 p-4 bg-white rounded-xl shadow-2xl border-t-4 border-blue-500 space-y-4">
                        <h2 className="text-xl font-bold text-blue-700">{uiState === 'new' ? 'Buat Template Baru' : `Edit Template: ${currentSpbu.name}`}</h2>
                        
                        <div className="flex space-x-2 items-end">
                            <div className="flex-grow">
                                <label className="text-sm font-medium text-gray-700 block mb-1">Nama SPBU</label>
                                <input type="text" name="name" value={currentSpbu.name} onChange={handleSpbuChange}
                                    className="w-full p-2 border rounded-lg bg-white" disabled={isProcessing || isAiGenerating} />
                            </div>
                            <button onClick={handleAiGenerateTemplate} disabled={isProcessing || isAiGenerating}
                                className={`bg-purple-600 text-white p-2 h-10 w-10 rounded-lg flex items-center justify-center transition ${isProcessing || isAiGenerating ? 'opacity-50 cursor-not-allowed' : 'hover:bg-purple-700'}`} title="Generate Alamat dengan AI">
                                {isAiGenerating ? <div className="spinner"></div> : '✨'}
                            </button>
                        </div>
                        
                        {/* Upload Logo */}
                        <div className="space-y-2">
                            {/* PERUBAHAN KRUSIAL DI SINI: Label dibuat 2 baris */}
                            <label className="text-sm font-medium text-gray-700 block mb-1 leading-snug">
                                Upload Logo Pertamina<br/>(Max {LOGO_MAX_WIDTH}px)
                            </label>
                            <input type="file" id="logo-upload" accept="image/*" onChange={handleImageUpload}
                                className="w-full p-2 border rounded-lg bg-white" disabled={isProcessing || isAiGenerating} />
                            <div className='flex justify-between items-center'>
                                <p className="text-xs text-red-500">
                                    Logo akan diubah menjadi *grayscale* (hitam putih).
                                </p>
                                {currentSpbu.logoBase64 && (
                                    <button onClick={handleClearLogo} className="text-xs text-red-600 hover:underline" disabled={isProcessing || isAiGenerating}>Hapus Logo</button>
                                )}
                            </div>
                        </div>

                        <div>
                            <label className="text-sm block">Alamat (Maksimal 2 Baris)</label>
                            <textarea name="address" rows="3" value={currentSpbu.address} onChange={handleSpbuChange}
                                className="w-full p-2 border rounded-lg" disabled={isProcessing || isAiGenerating}></textarea>
                        </div>
                        
                        <div>
                            <label className="text-sm font-medium text-gray-700 block mb-1">Lebar Nota (px) - Default: 275</label>
                            <input type="number" name="receiptWidth" value={currentSpbu.receiptWidth || ''} onChange={handleSpbuChange}
                                className="w-full p-2 border rounded-lg bg-white" min="150" max="300" disabled={isProcessing || isAiGenerating} />
                        </div>

                        <div className="flex space-x-2 pt-2">
                            <button onClick={handleSaveSpbu} disabled={isProcessing || isAiGenerating}
                                className={`flex-grow p-3 rounded-lg font-bold transition ${isProcessing ? 'bg-blue-300' : 'bg-blue-600 hover:bg-blue-700'} text-white`}>
                                {isProcessing ? (
                                    <span className="flex items-center justify-center"><div className="spinner mr-2"></div> Menyimpan...</span>
                                ) : 'Simpan Template'}
                            </button>
                            <button onClick={() => setUiState('view')} disabled={isProcessing || isAiGenerating}
                                className="bg-gray-400 text-white p-3 rounded-lg hover:bg-gray-500 transition font-bold">Batal</button>
                            {uiState === 'edit' && (
                                <button onClick={handleDeleteSpbu} disabled={isProcessing || isAiGenerating}
                                    className={`bg-red-500 text-white p-3 rounded-lg transition-colors font-bold ${isProcessing ? 'opacity-50' : 'hover:bg-red-600'}`}>Hapus</button>
                            )}
                        </div>
                    </div>
                )}
                
                {/* --- Bagian Data Transaksi (Conditional) --- */}
                {uiState === 'view' && (
                    <>
                        <div className="mb-6 p-4 bg-white rounded-xl shadow-lg">
                            <h2 className="text-xl font-bold mb-3 text-indigo-700">2. Data Transaksi</h2>
                            <div className="grid grid-cols-2 gap-3" id="transaction-inputs">
                                <TransactionInput 
                                    label="Shift" name="shift" value={transactionData.shift} inputType="tel" 
                                    onChange={handleTransactionChange} isProcessing={isProcessing} isAiGenerating={isAiGenerating} 
                                />
                                <TransactionInput 
                                    label="No.Trans" name="noTrans" value={transactionData.noTrans} inputType="text" showRandomButton={true}
                                    onChange={handleTransactionChange} generateRandomId={generateRandomTransId} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                />
                                <TransactionInput 
                                    label="Tanggal" name="date" value={transactionData.date} inputType="text" showSyncButton={true} 
                                    onChange={handleTransactionChange} updateDateTime={updateDateTime} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                />
                                <TransactionInput 
                                    label="Jam" name="time" value={transactionData.time} inputType="text" showSyncButton={true} 
                                    onChange={handleTransactionChange} updateDateTime={updateDateTime} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                />
                                <TransactionInput 
                                    label="Pulau/Pompa" name="islandPump" value={transactionData.islandPump} 
                                    onChange={handleTransactionChange} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                />
                                <TransactionInput 
                                    label="Produk" name="productName" value={transactionData.productName} 
                                    onChange={handleTransactionChange} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                />
                                <TransactionInput 
                                    label="Harga/L" name="pricePerLiter" value={transactionData.pricePerLiter} inputType="tel" 
                                    onChange={handleTransactionChange} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                />
                                <TransactionInput 
                                    label="Volume (L)" name="volume" value={isVolumeCalculated ? calculatedVolume.toFixed(2) : transactionData.volume} inputType="tel" disabled={isVolumeCalculated} 
                                    onChange={handleTransactionChange} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                />
                                <TransactionInput 
                                    label="Operator" name="operator" value={transactionData.operator} 
                                    onChange={handleTransactionChange} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                />
                                <TransactionInput 
                                    label="Nopol" name="nopol" value={transactionData.nopol} 
                                    onChange={handleTransactionChange} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                />
                                <div className="col-span-2">
                                    <TransactionInput 
                                        label="Nominal Beli (Rp)" name="cashAmount" value={transactionData.cashAmount} inputType="tel" 
                                        onChange={handleTransactionChange} isProcessing={isProcessing} isAiGenerating={isAiGenerating}
                                    />
                                </div>
                            </div>
                            <div id="total-display" className="mt-4 p-2 bg-indigo-100 text-indigo-800 font-bold rounded text-center">
                                TOTAL: Rp. {formatRupiah(finalPrice)}
                            </div>
                            <p id="calc-info" className="text-xs text-gray-600 mt-2 text-center">
                                {isVolumeCalculated 
                                    ? 'Volume dihitung dari Nominal Beli.' 
                                    : 'Nominal Beli dihitung dari Volume.'}
                            </p>
                        </div>

                        {/* Bagian Preview & Aksi */}
                        <div className="mb-6 p-4 bg-white rounded-xl shadow-2xl border-t-4 border-indigo-600">
                            <h2 className="text-xl font-bold mb-3 text-indigo-700">3. Preview & Aksi</h2>
                            <div className="bg-gray-100 border border-dashed p-4 overflow-x-auto flex justify-center">
                                <ReceiptPreviewComponent />
                            </div>
                            <div className="flex space-x-3 mt-4">
                                <button onClick={handleExportImage} disabled={!isLibReady || isProcessing || isAiGenerating}
                                    className={`flex-1 p-3 rounded-xl font-bold flex justify-center items-center space-x-1 transition ${!isLibReady || isProcessing || isAiGenerating ? 'bg-green-300 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'} text-white`}>
                                    {isProcessing && isLibReady ? <div className="spinner mr-2"></div> : 
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>}
                                    <span>Export PNG</span>
                                </button>
                                <button onClick={handlePrintReceipt} disabled={!isLibReady || isProcessing || isAiGenerating}
                                    className={`flex-1 p-3 rounded-xl font-bold flex justify-center items-center space-x-1 transition ${!isLibReady || isProcessing || isAiGenerating ? 'bg-indigo-300 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'} text-white`}>
                                    {isProcessing && isLibReady ? <div className="spinner mr-2"></div> : 
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m0 0h6m-6 0v2a2 2 0 002 2h2a2 2 0 002-2v-2" /></svg>}
                                    <span>Cetak 58mm</span>
                                </button>
                            </div>
                            
                            {/* BAGIAN BARU: Petunjuk Cetak */}
                            <div className="mt-6 pt-4 border-t border-gray-200 text-sm space-y-2 text-gray-700">
                                <p className="font-extrabold text-lg text-indigo-700">*** SARAN CETAK YANG BAIK ***</p>
                                <p>1. Ekspor nota menggunakan tombol **Export PNG** di atas.</p>
                                <p>2. Unduh Aplikasi **RawBT** atau Aplikasi Sejenis (Cari di Youtube: *Cara Cetak Gambar di Printer Thermal 58mm Bluetooth / Kabel*).</p>
                                
                                <p className="font-extrabold text-red-600 mt-4">***** CATATAN PENTING *****</p>
                                <p className="text-base font-semibold">
                                    Atur Ukuran **Lebar Nota (px)** pada Template SPBU (Bagian 1) dan otak-atik sendiri karena setiap HP Beda Settingan LEBAR NOTA-nya.
                                </p>
                            </div>
                            {/* AKHIR BAGIAN BARU */}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default App;
