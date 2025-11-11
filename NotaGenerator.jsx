import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, query, onSnapshot, deleteDoc } from 'firebase/firestore';

// --- Global Constants (Provided by environment) ---
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Data URI Fallback Image for Placeholder (Jika gambar utama gagal dimuat atau belum ada)
const FALLBACK_LOGO_URL = "https://placehold.co/205x70/ff0000/ffffff?text=LOGO+SPBU"; // Ukuran placeholder disesuaikan

// Utility for formatting currency (Rupiah)
const formatRupiah = (number) => {
  if (number === null || number === undefined || isNaN(number)) return '0';
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
};

// Utility for formatting time/date
const formatTime = (date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${hours} : ${minutes} : ${seconds}`;
}

const formatDate = (date) => {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

const generateId = () => 'spbu-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

// --- Initial Data ---
const initialTransactionData = {
    shift: '1',
    noTrans: Math.floor(100000 + Math.random() * 900000).toString(),
    date: formatDate(new Date()),
    time: formatTime(new Date()),
    islandPump: '1',
    productName: 'Pertalite',
    pricePerLiter: 10000,
    volume: 10.0,
    cashAmount: 100000,
    operator: 'Admin',
    nopol: 'DR 1234 XY',
};

const initialSpbuConfig = {
    name: 'SPBU PERTAMINA 00.000.00',
    address: 'ALAMAT SPBU LENGKAP',
    footerNote: 'Terimakasih dan selamat jalan',
    receiptWidth: 300, // Lebar default dalam px, cukup aman untuk 58mm (sekitar 384px printable)
    id: generateId(),
    logoBase64: null, // Menampung data gambar Base64
};

// --- UI Helpers (Memoized for stable focus) ---
// Dipindahkan keluar dari App untuk mencegah focus loss saat re-render
const Input = React.memo(({ label, name, inputType = 'text', value, onChange, disabled }) => (
    <div>
        <label className="text-sm font-medium text-gray-700 block mb-1">{label}</label>
        <input 
            type={inputType} 
            name={name} 
            value={value === 0 && !disabled ? '' : value} 
            onChange={onChange} 
            disabled={disabled} 
            pattern={inputType === 'tel' ? '[0-9]*' : undefined} 
            className={`w-full p-2 border rounded-lg ${disabled ? 'bg-gray-100' : 'bg-white'}`} 
        />
    </div>
));

// Utility untuk resize gambar dan mendapatkan Base64
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

            // Output Base64 dengan kualitas kompresi JPG 0.7 untuk mengurangi ukuran file
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            callback(dataUrl);
        };
        img.src = readerEvent.target.result;
    };
    reader.readAsDataURL(file);
};

// --- Receipt Component ---
const ReceiptView = React.forwardRef(({ spbu, transaction, totalPrice }, ref) => {
    const receiptStyle = "font-['Courier_New',_Courier,_monospace] text-xs text-black leading-tight bg-white p-2";
    const totalVolume = parseFloat(transaction.volume) || 0;
    const priceLiter = parseFloat(transaction.pricePerLiter) || 0;
    const finalPrice = totalPrice || (totalVolume * priceLiter);
    const cash = parseFloat(transaction.cashAmount) || finalPrice;

    const addressLines = (typeof spbu.address === 'string' ? spbu.address : '').split('\n');
    const footerLines = (typeof spbu.footerNote === 'string' ? spbu.footerNote : '').split('\n');
    
    // Sumber gambar Base64 atau Fallback
    const logoSrc = spbu.logoBase64 || FALLBACK_LOGO_URL;

    return (
        <div ref={ref} className={receiptStyle} style={{ width: `${spbu.receiptWidth || 300}px`, margin: '0 auto' }}>
            <div className="flex justify-center mb-1">
                <img 
                    src={logoSrc} 
                    alt="Logo SPBU" 
                    // Perubahan: Mengatur lebar menjadi 205px dan menambahkan filter grayscale
                    className="w-[205px] h-auto max-w-full filter grayscale" 
                    onError={(e) => { 
                        // Jika Base64 gagal (misalnya string korup), ganti ke URL fallback
                        e.target.onerror = null; 
                        e.target.src = FALLBACK_LOGO_URL; 
                    }} 
                />
            </div>
            <div className="text-center font-bold mb-2">
                <p className="text-sm">{spbu.name}</p>
                {addressLines.map((line, i) => <p key={i} className="text-xs scale-95 origin-center">{line}</p>)}
            </div>
            <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
            
            {/* START: PENYESUAIAN ALIGNMENT TITIK DUA */}
            <div className="grid grid-cols-2 gap-y-1 mb-2 text-[11px]">
                {/* Col 1: Shift - Menggunakan min-w-[65px] agar label sejajar */}
                <div className="flex col-span-1 pr-1">
                    <span className="inline-block min-w-[65px]">Shift</span>
                    <span>: {transaction.shift}</span>
                </div>
                {/* Col 2: No Trans - Menggunakan min-w-[65px] agar label sejajar */}
                <div className="flex col-span-1 pl-1">
                    <span className="inline-block min-w-[65px]">No Trans</span>
                    <span>: {transaction.noTrans}</span>
                </div>
                {/* Col 1: Waktu (Date) - TANGGAL DIBUAT TEBAL */}
                <div className="flex col-span-1 pr-1">
                    <span className="inline-block min-w-[65px]">Waktu</span>
                    <span className="font-bold">: {transaction.date}</span>
                </div>
                {/* Col 2: Waktu (Time) */}
                <div className="flex col-span-1 pl-1">
                    <span className="inline-block min-w-[65px]"></span>
                    <span>{transaction.time}</span>
                </div>
            </div>
            {/* END: PENYESUAIAN ALIGNMENT TITIK DUA */}

            <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
            {/* Blok Data Transaksi Utama: Disesuaikan untuk meratakan titik dua secara vertikal */}
            <div className="space-y-1 text-[11px]">
                {/* Menggunakan div flex justify-between. Di sisi kiri: Label dengan lebar tetap + Titik dua. Di sisi kanan: Nilai. */}
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[120px]">Pulau/Pompa</span>:
                    </span>
                    <span>{transaction.islandPump}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[120px]">Nama Produk</span>:
                    </span>
                    <span>{transaction.productName}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[120px]">Harga/Liter</span>:
                    </span>
                    <span>Rp. {formatRupiah(priceLiter)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[120px]">Volume</span>:
                    </span>
                    <span>(L) {totalVolume.toFixed(2)}</span>
                </div>
                {/* Total Harga tetap harus Bold dan diperbesar */}
                <div className="flex justify-between font-bold text-xs">
                    <span className="inline-flex">
                         <span className="inline-block w-[120px]">Total Harga</span>:
                    </span>
                    <span>Rp. {formatRupiah(finalPrice)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[120px]">Operator</span>:
                    </span>
                    <span>{transaction.operator}</span>
                </div>
                <div className="flex justify-between">
                    <span className="font-medium inline-flex">
                        <span className="inline-block w-[120px]">Nopol</span>:
                    </span>
                    <span>{transaction.nopol}</span>
                </div>
            </div>
            <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
            {/* CASH DIUBAH MENJADI TOTAL BAYAR DAN NOMINAL DIPERBESAR */}
            {/* Nominal diperbesar menjadi text-xl */}
            <div className="flex justify-between mt-2 font-bold text-xs">
                <span>Total Bayar</span>
                <span className="text-xl">Rp. {formatRupiah(cash)}</span> 
            </div>
            <div className="border-t border-b border-dashed border-black my-1 h-0"></div>
            <div className="text-center mt-2 text-[10px] whitespace-pre-line leading-tight">
                {footerLines.map((line, i) => <p key={i}>{line}</p>)}
            </div>
        </div>
    );
});

// --- Main App ---
export default function App() {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isLibReady, setIsLibReady] = useState(false); 

    const [spbuList, setSpbuList] = useState([]);
    const [selectedSpbuId, setSelectedSpbuId] = useState('');
    const [currentSpbu, setCurrentSpbu] = useState(initialSpbuConfig);
    const [transaction, setTransaction] = useState(initialTransactionData);
    const [feedback, setFeedback] = useState({ message: '', type: '' });

    const [isEditingSpbu, setIsEditingSpbu] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(false); 
    const receiptRef = useRef(null);

    const totalPrice = (parseFloat(transaction.volume) || 0) * (parseFloat(transaction.pricePerLiter) || 0);

    // Load html2canvas library dynamically
    useEffect(() => {
        if (window.html2canvas) {
            setIsLibReady(true);
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        script.async = true;
        script.onload = () => setIsLibReady(true);
        script.onerror = () => setFeedback({ message: 'Gagal memuat library pencetakan. Coba refresh.', type: 'error' });
        document.body.appendChild(script);
        return () => {
            if (document.body.contains(script)) {
                document.body.removeChild(script);
            }
        };
    }, []);

    // Auth Init
    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            setDb(getFirestore(app));
            const authInstance = getAuth(app);
            setAuth(authInstance);
            onAuthStateChanged(authInstance, async (user) => {
                if (user) { setUserId(user.uid); }
                else if (initialAuthToken) { await signInWithCustomToken(authInstance, initialAuthToken); setUserId(authInstance.currentUser?.uid); }
                else { await signInAnonymously(authInstance); setUserId(authInstance.currentUser?.uid); }
                setIsAuthReady(true);
                setIsLoading(false);
            });
        } catch (e) {
            setFeedback({ message: `Init Error: ${e.message}`, type: 'error' });
            setIsLoading(false);
        }
    }, []);

    // Data Fetch
    useEffect(() => {
        if (!isAuthReady || !db) return;
        const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'spbu_configs'));
        return onSnapshot(q, (snapshot) => {
            const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setSpbuList(list);
            if (list.length > 0 && !selectedSpbuId) setSelectedSpbuId(list[0].id);
        }, (e) => setFeedback({ message: 'Gagal memuat data.', type: 'error' }));
    }, [isAuthReady, db]);

    // Selection Sync
    useEffect(() => {
        const selected = spbuList.find(s => s.id === selectedSpbuId);
        if (selected) setCurrentSpbu(selected);
        else if (spbuList.length > 0) { setSelectedSpbuId(spbuList[0].id); setCurrentSpbu(spbuList[0]); }
        else setCurrentSpbu(initialSpbuConfig);
    }, [selectedSpbuId, spbuList]);

    // Handlers
    const handleTransactionChange = (e) => {
        const { name, value } = e.target;
        setTransaction(prev => ({ 
            ...prev, 
            [name]: ['volume', 'pricePerLiter', 'cashAmount'].includes(name) 
                ? (parseFloat(value) || 0) 
                : value 
        }));
    };

    const handleSpbuChange = (e) => setCurrentSpbu(prev => ({ ...prev, [e.target.name]: e.target.name === 'receiptWidth' ? (parseInt(e.target.value) || 300) : e.target.value }));
    
    // BARU: Handler untuk upload gambar langsung dari perangkat
    const handleImageUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setFeedback({ message: 'Sedang memproses gambar...', type: 'info' });
        
        // Resize gambar ke lebar maksimal 205px sebelum Base64
        resizeImageAndGetBase64(file, 205, (base64Data) => {
            setCurrentSpbu(prev => ({ ...prev, logoBase64: base64Data }));
            setFeedback({ message: 'Gambar berhasil diupload dan diresize. Jangan lupa klik Simpan.', type: 'success' });
        });
    };

    const handleClearLogo = () => {
        setCurrentSpbu(prev => ({ ...prev, logoBase64: null }));
        setFeedback({ message: 'Logo berhasil dihapus.', type: 'info' });
    };

    const handleSaveSpbu = async () => {
        if (!db || !currentSpbu.name) return setFeedback({ message: 'Nama SPBU wajib diisi.', type: 'error' });
        try {
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'spbu_configs', currentSpbu.id), currentSpbu, { merge: true });
            setSelectedSpbuId(currentSpbu.id);
            setIsEditingSpbu(false);
            setFeedback({ message: 'Tersimpan!', type: 'success' });
        } catch (e) { setFeedback({ message: `Gagal simpan: ${e.message}`, type: 'error' }); }
    };

    const handleAddNewSpbu = () => {
        setCurrentSpbu({ ...initialSpbuConfig, id: generateId(), name: 'SPBU BARU', logoBase64: null });
        setIsEditingSpbu(true);
        setSelectedSpbuId('');
    };

    const handleDeleteSpbu = async () => {
        if (!deleteConfirm) { setDeleteConfirm(true); setTimeout(() => setDeleteConfirm(false), 3000); return; }
        if (!db || !currentSpbu.id) return;
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'spbu_configs', currentSpbu.id));
            const remaining = spbuList.filter(s => s.id !== currentSpbu.id);
            setSelectedSpbuId(remaining.length > 0 ? remaining[0].id : '');
            setIsEditingSpbu(false);
            setDeleteConfirm(false);
            setFeedback({ message: 'Terhapus.', type: 'success' });
        } catch (e) { setFeedback({ message: `Gagal hapus: ${e.message}`, type: 'error' }); }
    };

    // Common function to generate canvas
    const generateCanvas = async () => {
        if (!window.html2canvas || !receiptRef.current) throw new Error('Library html2canvas belum siap atau tampilan nota tidak ditemukan. Mohon tunggu sebentar atau refresh halaman.');
        await new Promise(r => setTimeout(r, 100)); // Wait for render update
        return await window.html2canvas(receiptRef.current, { scale: 3, useCORS: true, backgroundColor: '#ffffff' });
    };

    const handlePrintReceipt = async () => {
        if (!isLibReady) return setFeedback({message: 'Tunggu sebentar, sedang memuat fitur cetak...', type: 'info'});
        setIsGenerating(true);
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
                                @page { 
                                    /* Mengatur lebar kertas 58mm dan tinggi otomatis (auto) */
                                    size: 58mm auto; 
                                    margin: 0mm;    
                                }
                                body { 
                                    margin: 0; 
                                    width: 58mm;    
                                    background-color: transparent;
                                    display: block; 
                                }
                                .print-container {
                                    width: 100%;
                                    /* Tinggi akan otomatis menyesuaikan konten */
                                    margin: 0;
                                }
                                img {
                                    width: 100%;    
                                    image-rendering: pixelated; 
                                }
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
        } catch (e) { setFeedback({ message: `Gagal cetak: ${e.message}`, type: 'error' }); }
        finally { setIsGenerating(false); }
    };

    const handleExportImage = async () => {
        if (!isLibReady) return setFeedback({message: 'Tunggu sebentar, sedang memuat fitur export...', type: 'info'});
        setIsGenerating(true);
        try {
            const canvas = await generateCanvas();
            const link = document.createElement('a');
            link.download = `Nota-${transaction.noTrans}-${transaction.nopol}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            setFeedback({ message: 'Gambar berhasil diexport!', type: 'success' });
        } catch (e) { setFeedback({ message: `Gagal export: ${e.message}`, type: 'error' }); }
        finally { setIsGenerating(false); }
    };

    const handleAiGenerateTemplate = async () => {
        if (!currentSpbu.name) return setFeedback({ message: 'Isi nama SPBU dulu.', type: 'error' });
        setIsAiGenerating(true);
        setFeedback({ message: '✨ Sedang membuat template...', type: 'info' });

        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `Buatkan data untuk SPBU bernama: "${currentSpbu.name}"` }] }],
                    systemInstruction: { parts: [{ text: `Anda asisten generator nota. Buat alamat fiktif realistis (multi-baris dengan \\n) dan footer profesional untuk SPBU. Balas HANYA JSON: {"address": "...", "footerNote": "..."}` }] },
                    generationConfig: { responseMimeType: "application/json" }
                })
            });
            const data = await response.json();
            const result = JSON.parse(data.candidates[0].content.parts[0].text);
            setCurrentSpbu(prev => ({ ...prev, address: result.address || prev.address, footerNote: result.footerNote || prev.footerNote }));
            setFeedback({ message: '✨ Template jadi!', type: 'success' });
        } catch (e) { setFeedback({ message: `AI Gagal: ${e.message}`, type: 'error' }); }
        finally { setIsAiGenerating(false); }
    };

    if (isLoading) return <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center text-white">Memuat...</div>;

    return (
        <div className="min-h-screen bg-gray-200 p-4 font-sans flex justify-center">
            {isGenerating && <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center text-white flex-col">
                <svg className="animate-spin h-10 w-10 text-white mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                <p>Memproses...</p>
            </div>}
            <div className="w-full max-w-md">
                <h1 className="text-3xl font-extrabold text-center text-gray-800 mb-4 border-b-4 border-indigo-500 pb-2">Generator Nota</h1>
                {feedback.message && <div className={`p-3 rounded-lg text-white mb-4 ${feedback.type === 'error' ? 'bg-red-500' : (feedback.type === 'success' ? 'bg-green-500' : 'bg-blue-500')}`}>{typeof feedback.message === 'string' ? feedback.message : 'Terjadi kesalahan'}</div>}

                <div className="mb-6 p-4 bg-gray-50 rounded-lg shadow-inner">
                    <h2 className="text-xl font-bold mb-3">1. Pilih SPBU</h2>
                    <div className="flex space-x-2">
                        <select value={selectedSpbuId} onChange={(e) => { setSelectedSpbuId(e.target.value); setIsEditingSpbu(false); }} className="flex-grow p-2 border rounded-lg" disabled={spbuList.length === 0}>
                            {spbuList.length === 0 ? <option value="">Kosong</option> : spbuList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <button onClick={() => selectedSpbuId && setIsEditingSpbu(true)} className="bg-yellow-500 text-white px-3 rounded-lg">Edit</button>
                        <button onClick={handleAddNewSpbu} className="bg-green-600 text-white px-3 rounded-lg">Baru</button>
                    </div>
                </div>

                {isEditingSpbu ? (
                    <div className="mb-6 p-4 bg-white rounded-lg shadow-xl border-t-4 border-blue-500 space-y-4">
                        <h2 className="text-xl font-bold text-blue-700">Edit Template</h2>
                        <div className="flex space-x-2 items-end">
                             <div className="flex-grow"><Input label="Nama SPBU" name="name" value={currentSpbu.name || ''} onChange={handleSpbuChange} /></div>
                             <button onClick={handleAiGenerateTemplate} disabled={isAiGenerating} className="bg-purple-600 text-white p-2 h-10 w-10 rounded-lg flex items-center justify-center" title="Generate dengan AI">{isAiGenerating ? '...' : '✨'}</button>
                        </div>
                        
                        {/* INPUT FILE BARU */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-gray-700 block">Upload Logo (Otomatis Resize & Grayscale)</label>
                            <input 
                                type="file" 
                                accept="image/*" 
                                onChange={handleImageUpload} 
                                className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-100 file:text-indigo-700 hover:file:bg-indigo-200"
                            />
                            <div className='flex justify-between items-center'>
                                <p className="text-xs text-red-500">
                                    PENTING: Gambar akan diresize otomatis (maks 205px) dan dikonversi ke Base64 agar dapat disimpan.
                                </p>
                                {currentSpbu.logoBase64 && (
                                    <button onClick={handleClearLogo} className="text-xs text-red-600 hover:underline">Hapus Logo</button>
                                )}
                            </div>
                        </div>

                        <div><label className="text-sm block">Alamat</label><textarea name="address" value={currentSpbu.address || ''} onChange={handleSpbuChange} rows={3} className="w-full p-2 border rounded-lg" /></div>
                        <div><label className="text-sm block">Footer</label><textarea name="footerNote" value={currentSpbu.footerNote || ''} onChange={handleSpbuChange} rows={3} className="w-full p-2 border rounded-lg" /></div>
                        <Input label="Lebar Nota (px) - Default: 300" name="receiptWidth" value={currentSpbu.receiptWidth || 300} onChange={handleSpbuChange} inputType="tel" />
                        <div className="flex space-x-2 mt-4">
                            <button onClick={handleSaveSpbu} className="flex-grow bg-blue-600 text-white p-2 rounded-lg">Simpan</button>
                            <button onClick={() => setIsEditingSpbu(false)} className="bg-gray-400 text-white p-2 rounded-lg">Batal</button>
                            {spbuList.length > 0 && <button onClick={handleDeleteSpbu} className={`${deleteConfirm ? 'bg-red-700' : 'bg-red-500'} text-white p-2 rounded-lg transition-colors`}>{deleteConfirm ? 'Yakin Hapus?' : 'Hapus'}</button>}
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="mb-6 p-4 bg-gray-50 rounded-lg shadow-inner">
                            <h2 className="text-xl font-bold mb-3">2. Data Transaksi</h2>
                            <div className="grid grid-cols-2 gap-3">
                                <Input label="Shift" name="shift" value={transaction.shift} onChange={handleTransactionChange} inputType="tel" />
                                <Input label="No. Trans" name="noTrans" value={transaction.noTrans} onChange={handleTransactionChange} inputType="tel" />
                                <Input label="Tgl" name="date" value={transaction.date} onChange={handleTransactionChange} />
                                <Input label="Jam" name="time" value={transaction.time} onChange={handleTransactionChange} />
                                
                                <Input label="Pulau/Pompa" name="islandPump" value={transaction.islandPump} onChange={handleTransactionChange} />
                                <Input label="Produk" name="productName" value={transaction.productName} onChange={handleTransactionChange} />
                                <Input label="Harga/L" name="pricePerLiter" value={transaction.pricePerLiter} onChange={handleTransactionChange} inputType="tel" />
                                <Input label="Volume (L)" name="volume" value={transaction.volume} onChange={handleTransactionChange} />
                                <Input label="Operator" name="operator" value={transaction.operator} onChange={handleTransactionChange} />
                                <Input label="Nopol" name="nopol" value={transaction.nopol} onChange={handleTransactionChange} />
                                <div className="col-span-2"><Input label="Uang Cash (Rp)" name="cashAmount" value={transaction.cashAmount} onChange={handleTransactionChange} inputType="tel" /></div>
                            </div>
                            <div className="mt-4 p-2 bg-blue-100 text-blue-800 font-bold rounded text-center">TOTAL: Rp. {formatRupiah(totalPrice)}</div>
                        </div>
                        <div className="mb-6 p-4 bg-white rounded-lg shadow-xl border-t-4 border-indigo-500">
                            <h2 className="text-xl font-bold mb-3">3. Preview & Aksi</h2>
                            <div className="bg-gray-100 border border-dashed p-4 overflow-x-auto flex justify-center">
                                <ReceiptView ref={receiptRef} spbu={currentSpbu || initialSpbuConfig} transaction={transaction} totalPrice={totalPrice} />
                            </div>
                            <div className="flex space-x-3 mt-4">
                                <button onClick={handleExportImage} disabled={!isLibReady || isGenerating} className={`flex-1 text-white p-3 rounded-xl font-bold flex justify-center items-center space-x-1 transition ${!isLibReady ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'}`}>
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                    <span>{isLibReady ? 'Export PNG' : 'Memuat...'}</span>
                                </button>
                                <button onClick={handlePrintReceipt} disabled={!isLibReady || isGenerating} className={`flex-1 text-white p-3 rounded-xl font-bold flex justify-center items-center space-x-1 transition ${!isLibReady ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m0 0h6m-6 0v2a2 2 0 002 2h2a2 2 0 002-2v-2" /></svg>
                                    <span>{isLibReady ? 'Cetak 58mm' : 'Memuat...'}</span>
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
