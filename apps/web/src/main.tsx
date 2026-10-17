import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';
import './design.css';
import './readability.css';
import './components/assistant.css';

const queryClient=new QueryClient({defaultOptions:{queries:{retry:1,refetchOnWindowFocus:true,staleTime:5000}}});
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}><App/></QueryClientProvider></React.StrictMode>);
